/**
 * Virtualobby — Dual-WebSocket WebApp
 *
 * Flow: connect DO → camera/file upload → OCR (optional) → voice → questions → done
 */

const CONFIG = {
    API_URL: 'https://virtualobby-api.alejdro.workers.dev',
    VOICE_AGENT_URL: 'wss://agents.assemblyai.com/v1/ws',
    tgApp: window.Telegram?.WebApp || null,
};

const WIRE_RATE = 24_000;

// AssemblyAI's defaults (vad_threshold 0.5, no interruption_delay) are quick
// to treat any ambient sound as a barge-in — and once interrupted, the reply
// is simply gone (no resume), so the agent re-decides what to say next,
// which shows up as it re-asking the same question. Per AssemblyAI docs,
// raising these two reduces false-positive interruptions from background
// noise while still letting genuine speech interrupt; min_silence/max_silence
// are deliberately left unset (adaptive end-of-turn timing).
const TURN_DETECTION = { vad_threshold: 0.65, interruption_delay: 600 };

// ── Debug Log (visible in UI) ────────────────────────────────────────────

const _debugLines = [];
function dbg(msg) {
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = `[${ts}] ${msg}`;
    _debugLines.push(line);
    if (_debugLines.length > 80) _debugLines.shift();
    console.log(line);
    const el = document.getElementById('debug-log');
    if (el) { el.textContent = _debugLines.join('\n'); el.scrollTop = el.scrollHeight; }
}

const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() { super(); this._ratio = sampleRate / ${WIRE_RATE}; this._pos = 0; this._prev = 0; }
    _toPcm(s, n) { const p = new Int16Array(n); for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, s[i])); p[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return p; }
    process(inputs) {
      const ch = inputs[0]?.[0]; if (!ch) return true;
      if (this._ratio === 1) { const p = this._toPcm(ch, ch.length); this.port.postMessage(p.buffer, [p.buffer]); return true; }
      const n = ch.length; if (!this._src || this._src.length < n + 1) { this._src = new Float32Array(n + 1); this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2); }
      this._src[0] = this._prev; this._src.set(ch, 1); let o = 0, pos = this._pos;
      while (pos < n) { const i = Math.floor(pos), f = pos - i; this._out[o++] = this._src[i] + (this._src[i + 1] - this._src[i]) * f; pos += this._ratio; }
      this._pos = pos - n; this._prev = ch[n - 1];
      if (o) { const p = this._toPcm(this._out, o); this.port.postMessage(p.buffer, [p.buffer]); } return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() { super(); this._ring = new Float32Array(sampleRate * 30); this._w = 0; this._r = 0; this._a = 0; this._step = ${WIRE_RATE} / sampleRate; this._rs = 0; this._rp = 0; this._dr = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') { this._w = this._r = this._a = 0; this._rs = this._rp = 0; return; }
        const d = new Int16Array(e.data); if (!d.length) return;
        if (this._dr) { this._rp = 0; this._rs = 0; this._dr = false; }
        if (this._step === 1) { for (let i = 0; i < d.length; i++) this._push(d[i] / 32768); return; }
        let pos = this._rs;
        while (pos < d.length) { const i = Math.floor(pos), f = pos - i; const a = i === 0 ? this._rp : d[i - 1] / 32768; this._push(a + (d[i] / 32768 - a) * f); pos += this._step; }
        this._rs = pos - d.length; this._rp = d[d.length - 1] / 32768;
      };
    }
    _push(v) { if (this._a < this._ring.length) { this._ring[this._w] = v; this._w = (this._w + 1) % this._ring.length; this._a++; } }
    process(inputs, outputs) { const o = outputs[0][0], c = this._ring.length;
      for (let i = 0; i < o.length; i++) { if (this._a > 0) { o[i] = this._ring[this._r]; this._r = (this._r + 1) % c; this._a--; } else { o[i] = 0; this._dr = true; } }
      for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(o); return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`;

// ── State ──────────────────────────────────────────────────────────────────

const state = {
    businessId: null, businessName: '', sessionId: null, doWs: null, aaiWs: null,
    captureCtx: null, playbackCtx: null, playback: null, mic: null,
    aaiReady: false, questions: [], answers: {}, ocrData: null,
    requiresIdScan: false, voiceConnecting: false, pendingToolResults: [],
    // True once the DO has moved past scanning (questions_ready received),
    // regardless of whether OCR actually found anything — OCR is best-effort
    // and empty fields is an expected outcome, not a reason to stay in the
    // greeting-only phase forever.
    scanCompleted: false, pendingInterviewHandoff: false,
    // True while a scan is required but not yet confirmed — mic audio is not
    // forwarded to AssemblyAI during this window (see capture.port.onmessage
    // in connectToAssemblyAI), so the visitor talking while OCR is still
    // running can't trigger a mid-scan reply that then collides with the
    // interview handoff once OCR finishes.
    micMuted: false,
};

const $ = (id) => document.getElementById(id) || document.querySelector(`.${id}`);
const elements = {
    stepScan: $('step-scan'), stepVoice: $('step-voice'), stepConfirm: $('step-confirm'),
    ocrResult: $('ocr-result'), ocrFields: $('ocr-fields'), ocrLoading: $('ocr-loading'),
    scanActions: $('scan-actions'), transcriptMessages: $('transcript-messages'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    btnNewVisitor: $('btn-new-visitor'), confirmMessage: $('confirm-message'), confirmId: $('confirm-id'),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function updateStatus(text) {
    dbg('STATUS: ' + text);
    if (elements.statusText) elements.statusText.textContent = text;
    if (elements.statusDot) elements.statusDot.className = 'status-dot ' + (text.includes('Listening') ? 'listening' : text.includes('Speaking') ? 'speaking' : '');
}

function showStep(step) {
    dbg('STEP → ' + step);
    [{ scan: elements.stepScan, voice: elements.stepVoice, confirm: elements.stepConfirm }].forEach(steps => {
        for (const [k, el] of Object.entries(steps)) if (el) el.classList.toggle('hidden', k !== step);
    });
}

function addMessage(who, text) {
    if (!elements.transcriptMessages) return;
    const div = document.createElement('div'); div.className = `message ${who}`; div.textContent = text;
    elements.transcriptMessages.appendChild(div);
    elements.transcriptMessages.scrollTop = elements.transcriptMessages.scrollHeight;
}

// ── Init ───────────────────────────────────────────────────────────────────

function initTelegram() {
    const tg = CONFIG.tgApp; if (!tg) { dbg('No Telegram WebApp object'); return; }
    tg.ready(); tg.expand();
    const sp = (tg.initDataUnsafe || {}).start_param || '';
    dbg('start_param: ' + (sp || '(none)'));
    // admin.html's QR/link generator encodes ?start=business_<id> (see
    // getTelegramLink in admin.html) — strip that prefix back off, otherwise
    // every visitor arriving via a business's QR code gets a business_id
    // that doesn't exist in D1 ("business_<id>" instead of "<id>") and the
    // DO immediately errors out with "Business not found".
    if (sp) state.businessId = sp.startsWith('business_') ? sp.slice('business_'.length) : sp;
}

async function init() {
    dbg('=== APP INIT START ===');
    initTelegram();
    if (!state.businessId) { state.businessId = 'clinic-main'; dbg('Using default businessId: clinic-main'); }
    initEventListeners();
    updateStatus('Connecting...');
    dbg('Calling connectToDO()...');
    await connectToDO();
}

// ── DO WebSocket ───────────────────────────────────────────────────────────

async function connectToDO() {
    state.sessionId = crypto.randomUUID();
    const wsUrl = `${CONFIG.API_URL.replace('https://', 'wss://')}/api/ws/${state.sessionId}`;
    dbg('DO WS URL: ' + wsUrl);
    state.doWs = new WebSocket(wsUrl);

    // Timeout: if WebSocket doesn't open in 10s, show error
    const connectTimeout = setTimeout(() => {
        if (state.doWs && state.doWs.readyState !== WebSocket.OPEN) {
            dbg('ERROR: DO WebSocket timed out after 10s');
            updateStatus('Connection timed out — check network');
        }
    }, 10000);

    state.doWs.onopen = () => {
        clearTimeout(connectTimeout);
        dbg('DO WebSocket OPENED ✓');
        const startMsg = { type: 'start', business_id: state.businessId };
        dbg('Sending to DO: ' + JSON.stringify(startMsg));
        state.doWs.send(JSON.stringify(startMsg));
        updateStatus('Loading business...');
    };

    state.doWs.onmessage = (e) => {
        dbg('DO MSG raw: ' + (typeof e.data === 'string' ? e.data.substring(0, 200) : '(binary)'));
        try {
            const msg = JSON.parse(e.data);
            handleDOMessage(msg);
        } catch (err) {
            dbg('ERROR parsing DO message: ' + err.message);
        }
    };

    state.doWs.onerror = (err) => {
        clearTimeout(connectTimeout);
        dbg('DO WebSocket ERROR');
        updateStatus('Connection error — check network');
    };

    state.doWs.onclose = (ev) => {
        clearTimeout(connectTimeout);
        dbg('DO WebSocket CLOSED code=' + ev.code + ' reason=' + (ev.reason || '(none)'));
        if (ev.code !== 1000 && ev.code !== 1005) {
            updateStatus('Connection closed: ' + (ev.reason || 'code ' + ev.code));
        }
    };
}

function handleDOMessage(msg) {
    dbg('DO ← type=' + msg.type);

    switch (msg.type) {
        case 'welcome':
            state.businessName = msg.business_name || '';
            state.requiresIdScan = msg.requires_id_scan;
            state.questions = msg.questions || [];
            dbg('Welcome: biz=' + state.businessName + ' requiresIdScan=' + state.requiresIdScan + ' questions=' + state.questions.length);
            const ht = $('header-title');
            if (ht) ht.textContent = `Welcome to ${state.businessName}`;
            updateStatus(`Welcome to ${state.businessName}!`);
            // Connect voice immediately so Anna speaks the greeting
            showStep(state.requiresIdScan ? 'scan' : 'voice');
            connectToAssemblyAI().catch(err => {
                dbg('Voice failed: ' + err.message);
                updateStatus('Voice failed: ' + err.message);
            });
            break;

        case 'request_camera':
            dbg('Request camera received');
            updateStatus('Please upload your ID');
            showStep('scan');
            break;

        case 'ocr_result':
            dbg('OCR result received, success=' + msg.success);
            state.ocrData = msg.fields;
            elements.ocrLoading?.classList.add('hidden');
            displayOCRResult(msg.fields);
            break;

        case 'questions_ready':
            dbg('Questions ready received, clearing OCR timeout');
            clearTimeout(state.ocrTimeout);
            state.questions = msg.questions || state.questions;
            state.ocrData = msg.ocr_data || state.ocrData;
            state.businessName = msg.business_name || state.businessName;
            dbg('Questions count: ' + state.questions.length + ' ocrData: ' + JSON.stringify(state.ocrData));
            showStep('voice');
            proceedToInterview();
            break;

        case 'state':
            dbg('Question state: ' + (msg.index + 1) + '/' + msg.total + ': ' + msg.question);
            updateStatus(`Question ${msg.index + 1}/${msg.total}: ${msg.question}`);
            break;

        case 'summary': showSummary(msg.answers, msg.ocr); break;
        case 'checkin_complete': showDone(msg.registration_id); break;

        case 'error':
            dbg('DO ERROR: ' + msg.message);
            updateStatus('Error: ' + msg.message);
            break;

        default:
            dbg('Unknown DO message type: ' + msg.type);
            break;
    }
}

// ── Upload ─────────────────────────────────────────────────────────────────

const OCR_MAX_DIMENSION = 1600; // px, longest side — plenty for ID-card text legibility
const OCR_JPEG_QUALITY = 0.85;

// Phone camera photos are often several MB and 3000px+ on a side, which
// slows both the upload and the vision model's OCR pass (bigger image =
// more tokens to prefill). Downscale before upload; fall back to the
// original file untouched if anything in this path fails or isn't supported.
async function downscaleImage(blobOrFile) {
    try {
        const bitmap = await createImageBitmap(blobOrFile, { imageOrientation: 'from-image' });
        const { width, height } = bitmap;
        const scale = Math.min(1, OCR_MAX_DIMENSION / Math.max(width, height));
        if (scale >= 1) { bitmap.close?.(); return blobOrFile; } // already small enough
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((b) => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/jpeg', OCR_JPEG_QUALITY);
        });
        dbg(`Downscaled image for OCR: ${width}x${height} -> ${canvas.width}x${canvas.height}, ${blob.size} bytes`);
        return blob;
    } catch (err) {
        dbg('Image downscale failed, uploading original: ' + err.message);
        return blobOrFile;
    }
}

async function uploadAndProcess(blobOrFile, contentType) {
    elements.ocrLoading?.classList.remove('hidden');
    updateStatus('Uploading...');

    try {
        if (!state.sessionId) throw new Error('No active session');

        const uploadBlob = await downscaleImage(blobOrFile);
        const uploadContentType = uploadBlob === blobOrFile ? (contentType || 'image/jpeg') : 'image/jpeg';

        // Upload goes straight to our DO-scoped endpoint (PUT /api/ws/<sessionId>).
        // The Durable Object only accepts it while this visitor's session is in the
        // "scanning_doc" state, so there's no open write proxy to abuse.
        dbg('Uploading blob to DO-scoped endpoint...');
        const putResp = await fetch(`${CONFIG.API_URL}/api/ws/${state.sessionId}`, {
            method: 'PUT',
            headers: { 'Content-Type': uploadContentType },
            body: uploadBlob,
        });
        if (!putResp.ok) {
            const t = await putResp.text().catch(() => '');
            throw new Error('Upload failed: ' + putResp.status + ' ' + t);
        }
        const { r2_key } = await putResp.json();
        dbg('Upload complete, r2_key=' + r2_key);

        if (state.doWs?.readyState !== 1) {
            dbg('DO NOT READY: readyState=' + (state.doWs?.readyState || 'null'));
            throw new Error('DO connection lost');
        }
        const idMsg = { type: 'id_uploaded', r2_key };
        dbg('Sending to DO: readyState=' + state.doWs.readyState + ' url=' + state.doWs.url + ' msg=' + JSON.stringify(idMsg));
        state.doWs.send(JSON.stringify(idMsg));
        updateStatus('Processing document...');

        // Safety timeout: if DO doesn't respond in 15s, skip OCR and go to voice
        state.ocrTimeout = setTimeout(() => {
            dbg('OCR TIMEOUT (15s) — going to voice without OCR');
            updateStatus('Connecting voice (OCR timeout)...');
            showStep('voice');
            proceedToInterview();
        }, 15000);

    } catch (err) {
        dbg('Upload error: ' + err.message);
        updateStatus('Upload failed: ' + err.message);
        elements.ocrLoading?.classList.add('hidden');
    }
}

// ── AssemblyAI Voice ───────────────────────────────────────────────────────

async function connectToAssemblyAI() {
    // Guard: prevent double-calling (OCR timeout + questions_ready race)
    if (state.voiceConnecting || state.aaiWs) {
        dbg('Voice already connecting/connected — SKIPPING');
        return;
    }
    state.voiceConnecting = true;

    dbg('connectToAssemblyAI() START');

    // 1. Get token
    let token;
    try {
        const tokenUrl = `${CONFIG.API_URL}/api/token`;
        dbg('Fetching token from: ' + tokenUrl);
        const tokenResp = await fetch(tokenUrl);
        dbg('Token response status: ' + tokenResp.status);
        if (!tokenResp.ok) {
            const errBody = await tokenResp.text();
            dbg('Token error body: ' + errBody);
            throw new Error(`Token HTTP ${tokenResp.status}: ${errBody}`);
        }
        const data = await tokenResp.json();
        token = data.token;
        if (!token) {
            dbg('Token response data: ' + JSON.stringify(data));
            throw new Error('No token in response');
        }
        dbg('Token received ✓ (length=' + token.length + ')');
    } catch (e) {
        state.voiceConnecting = false;
        dbg('TOKEN FETCH FAILED: ' + e.message);
        throw new Error('Token fetch failed: ' + e.message);
    }

    // 2. Set up audio
    dbg('Creating AudioContexts at ' + WIRE_RATE + ' Hz...');
    state.captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
    state.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
    dbg('captureCtx.state=' + state.captureCtx.state + ' playbackCtx.state=' + state.playbackCtx.state);

    await state.captureCtx.resume();
    await state.playbackCtx.resume();
    dbg('After resume: capture=' + state.captureCtx.state + ' playback=' + state.playbackCtx.state);

    updateStatus('Requesting microphone...');
    let stream;
    try {
        dbg('Calling getUserMedia...');
        stream = await Promise.race([
            navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Mic permission timeout (10s)')), 10000)),
        ]);
        dbg('getUserMedia OK, tracks=' + stream.getAudioTracks().length);
    } catch (micErr) {
        dbg('MIC FAILED: ' + micErr.message);
        state.voiceConnecting = false;
        state.captureCtx?.close(); state.playbackCtx?.close();
        state.captureCtx = state.playbackCtx = null;
        throw new Error('Microphone access failed: ' + micErr.message);
    }
    state.mic = stream;

    dbg('Setting up capture worklet...');
    const source = state.captureCtx.createMediaStreamSource(stream);
    const capture = await addWorklet(state.captureCtx, CAPTURE_WORKLET, 'capture');
    source.connect(capture);
    // NOTE: do NOT connect capture to destination — it only posts PCM via port.onmessage

    dbg('Setting up playback worklet...');
    state.playback = await addWorklet(state.playbackCtx, PLAYBACK_WORKLET, 'playback');
    state.playback.connect(state.playbackCtx.destination);

    // 3. Connect to AssemblyAI
    const aaiUrl = `${CONFIG.VOICE_AGENT_URL}?token=${token}`;
    dbg('Connecting AAI WebSocket to: ' + CONFIG.VOICE_AGENT_URL + '?token=***');
    state.aaiWs = new WebSocket(aaiUrl);

    // AAI connection timeout
    const aaiTimeout = setTimeout(() => {
        if (state.aaiWs && state.aaiWs.readyState !== WebSocket.OPEN) {
            dbg('ERROR: AAI WebSocket timed out after 10s');
            updateStatus('Voice connection timed out');
            state.voiceConnecting = false;
        }
    }, 10000);

    capture.port.onmessage = ({ data }) => {
        if (!state.aaiReady || state.aaiWs?.readyState !== 1 || state.micMuted) return;
        const bytes = new Uint8Array(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        state.aaiWs.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }));
    };

    state.aaiWs.onopen = () => {
        clearTimeout(aaiTimeout);
        dbg('AAI WebSocket OPENED ✓ — sending session.update');

        // Two phases: while a scan is still pending, this is announcement-only
        // (greet + tell them to scan, then stay quiet — not an interview yet).
        // Once scanning has completed (regardless of whether OCR found
        // anything — empty is a valid outcome), it switches to the real
        // Q&A prompt/tools, either here or later via sendInterviewHandoff.
        const scanPending = state.requiresIdScan && !state.scanCompleted;
        // Mute the outgoing mic entirely while scanning is still pending —
        // relying on the prompt telling the agent to "stay quiet" isn't
        // reliable, and letting the visitor's speech through can start a
        // real exchange that then collides with the interview handoff once
        // OCR finishes. Unmuted again in sendInterviewHandoff.
        state.micMuted = scanPending;

        const sessionUpdate = {
            type: 'session.update',
            session: scanPending
                ? {
                    system_prompt: buildGreetingOnlyPrompt(),
                    greeting: `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today. Please upload your ID document using the button on screen.`,
                    output: { voice: 'anna' },
                    input: { turn_detection: TURN_DETECTION },
                    tools: [],
                }
                : {
                    system_prompt: buildInterviewPrompt(),
                    greeting: `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today. Let's get you checked in.`,
                    output: { voice: 'anna' },
                    input: { turn_detection: TURN_DETECTION },
                    tools: buildInterviewTools(),
                },
        };
        dbg('Sending session.update (scanPending=' + scanPending + ')');
        state.aaiWs.send(JSON.stringify(sessionUpdate));
        dbg('session.update sent ✓ — waiting for session.ready');
    };

    state.aaiWs.onmessage = ({ data }) => {
        try {
            handleAAILogic(JSON.parse(data));
        } catch (err) {
            dbg('ERROR parsing AAI message: ' + err.message);
        }
    };

    state.aaiWs.onerror = (err) => {
        clearTimeout(aaiTimeout);
        dbg('AAI WebSocket ERROR');
        updateStatus('Voice connection error');
        state.voiceConnecting = false;
    };

    state.aaiWs.onclose = (ev) => {
        clearTimeout(aaiTimeout);
        dbg('AAI WebSocket CLOSED code=' + ev.code + ' reason=' + (ev.reason || '(none)'));
        state.aaiReady = false;
        state.voiceConnecting = false;
        state.aaiWs = null;
        if (ev.code !== 1000) updateStatus('Voice disconnected — ' + (ev.reason || 'code ' + ev.code));
    };
}

function handleAAILogic(msg) {
    dbg('AAI ← ' + msg.type);
    switch (msg.type) {
        case 'session.ready':
            dbg('session.ready — VOICE IS LIVE ✓');
            state.aaiReady = true;
            state.voiceConnecting = false;
            updateStatus('Listening...');
            // If scanning finished while voice was still connecting, the
            // initial session.update (sent on WS open) used the stale
            // scanPending state — switch to the interview prompt now.
            if (state.pendingInterviewHandoff) {
                state.pendingInterviewHandoff = false;
                sendInterviewHandoff();
            }
            break;

        case 'input.speech.started':
            state.playback?.port.postMessage('stop');
            break;

        case 'reply.audio': {
            const raw = atob(msg.data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            state.playback?.port.postMessage(bytes.buffer, [bytes.buffer]);
            break;
        }

        case 'reply.started': updateStatus('Speaking...'); break;
        case 'reply.done':
            updateStatus('Listening...');
            if (msg.status === 'interrupted') {
                // Per AssemblyAI docs: discard any tool.result queued during a reply
                // that got cut short — the turn it belonged to no longer exists.
                state.playback?.port.postMessage('stop');
                state.pendingToolResults = [];
            } else {
                flushPendingToolResults();
            }
            break;
        case 'transcript.user': addMessage('user', msg.text); break;
        case 'transcript.agent': addMessage('agent', msg.text); break;
        case 'session.ended': state.aaiReady = false; break;
        case 'session.error': dbg('AAI session.error: ' + msg.message); updateStatus('Voice error: ' + msg.message); break;

        case 'tool.call':
            queueToolResult(msg);
            break;
        default:
            dbg('Unhandled AAI message: ' + msg.type + ' ' + JSON.stringify(msg).substring(0, 200));
            break;
    }
}

// ── Tool calls ─────────────────────────────────────────────────────────────
// Per AssemblyAI docs, tool.result must be sent only once reply.done is the
// latest event received (never immediately on tool.call) — so we queue here
// and flush from the reply.done handler in handleAAILogic.

function queueToolResult(msg) {
    if (msg.name === 'submit_answer') {
        const answer = msg.arguments?.answer || '';
        dbg('Tool call queued submit_answer: ' + answer);
        if (state.doWs?.readyState === 1) state.doWs.send(JSON.stringify({ type: 'user_transcript', text: answer }));
        state.pendingToolResults.push({ call_id: msg.call_id, result: JSON.stringify({ success: true }) });
    } else if (msg.name === 'correct_ocr_field') {
        // Without this, a spoken correction only ever lived in the LLM's own
        // conversation memory — it would say the fix back correctly, but the
        // stored ocrData (on-screen card, final summary, and the D1 record)
        // stayed on the original wrong OCR value forever.
        const field = msg.arguments?.field;
        const value = msg.arguments?.value;
        dbg('Tool call correct_ocr_field: ' + field + ' = ' + value);
        const ok = !!(field && value);
        if (ok) {
            state.ocrData = { ...(state.ocrData || {}), [field]: value };
            displayOCRResult(state.ocrData);
            if (state.doWs?.readyState === 1) state.doWs.send(JSON.stringify({ type: 'ocr_correction', field, value }));
        }
        state.pendingToolResults.push({ call_id: msg.call_id, result: JSON.stringify({ success: ok }) });
    } else {
        dbg('Unhandled tool.call: ' + msg.name);
        state.pendingToolResults.push({ call_id: msg.call_id, result: JSON.stringify({ success: false, error: 'unknown tool' }) });
    }
}

function flushPendingToolResults() {
    if (!state.pendingToolResults.length) return;
    for (const tr of state.pendingToolResults) {
        if (state.aaiWs?.readyState === 1) {
            state.aaiWs.send(JSON.stringify({ type: 'tool.result', call_id: tr.call_id, result: tr.result }));
        }
    }
    state.pendingToolResults = [];
}

// ── Voice prompts ────────────────────────────────────────────────────────
// Two prompts, one per phase of the conversation. `greeting` is immutable
// once a session is live (AssemblyAI docs), so the scan→interview handoff
// (sendInterviewHandoff) only ever touches system_prompt/tools/input
// (turn_detection) — never greeting or output.

// Phase 1 (only used while requires_id_scan is true and OCR hasn't landed
// yet): announcement-only, no tools, agent stays quiet after the greeting
// instead of launching into the questionnaire before the visitor has scanned.
function buildGreetingOnlyPrompt() {
    return `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.

Your only task right now is to greet the visitor and tell them to scan their ID document using the button on screen.

Do NOT ask any interview questions yet — the questionnaire happens later, once the visitor's ID has been scanned. After the greeting, stay quiet and do not speak again on your own.`;
}

// Phase 2: the real check-in interview. Used either from the very start (no
// scan required) or once OCR data is available (via sendInterviewHandoff).
// The OCR confirmation ("Thank you Mr./Ms. X, is this correct?") is treated
// as a separate step BEFORE the numbered questions, deliberately excluded
// from submit_answer — the DO records answers by list position
// (questions[currentQuestionIndex]), so submitting the OCR yes/no through
// that tool would consume question 1's slot and shift every answer after it.
function buildInterviewPrompt() {
    const ocrName = state.ocrData?.name || '';
    const ocrFields = state.ocrData ? Object.entries(state.ocrData).filter(([k, v]) => v && k !== 'name').map(([k, v]) => `${k}: ${v}`).join(', ') : '';
    const ocrSection = ocrName
        ? `\nID SCAN RESULT:\n- Name: ${ocrName}${ocrFields ? '\n- ' + ocrFields : ''}\n\nSTEP 1 (do this first, before any numbered question): thank the visitor by name — say something like "Thank you, Mr./Ms. ${ocrName}!" — then read back the data above and ask "Is this correct?" Wait for a yes or no. Do NOT call submit_answer for this — it is not one of the numbered questions. If they say ANY field is wrong, ask them to state the correct value, then immediately call correct_ocr_field with that field and the corrected value — do this for every field they correct, before moving on to STEP 2.`
        : '';
    const questionsList = (state.questions || []).map((q, i) => `${i + 1}. "${q.text}" (field: ${q.field})`).join('\n');

    return `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.
${ocrSection}

STEP 2 — QUESTIONS (ask ONE AT A TIME, in order, only after the ID scan is confirmed):
${questionsList}

FLOW:
${ocrSection ? '1. Do STEP 1 (confirm ID scan) first\n2. Then STEP 2' : '1. Start with STEP 2'}
- For each question: ask it, wait for the answer, confirm briefly ("Got it", "Understood", "Perfect"), then call submit_answer with their answer, then move to the next question
- After all questions, summarize everything and ask "Is everything correct?"

RULES:
- Speak in the visitor's language
- Keep sentences short — this is voice
- Never generate your own questions
- submit_answer is ONLY for the numbered questions in STEP 2 — never for the ID scan confirmation
- correct_ocr_field is ONLY for fixing wrong ID scan data — call it as soon as the visitor states a correction, never skip this step`;
}

function buildInterviewTools() {
    return [
        {
            type: 'function',
            name: 'submit_answer',
            description: 'Submit the visitor answer for the current numbered question. Do not use this for the ID scan confirmation step.',
            parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
        },
        {
            type: 'function',
            name: 'correct_ocr_field',
            description: 'Call this immediately when the visitor says any piece of the scanned ID data is wrong, with the field name and the corrected value they state. Must be called before moving on to the numbered questions.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', enum: ['name', 'id_number', 'date_of_birth', 'address'], description: 'Which ID field is being corrected' },
                    value: { type: 'string', description: 'The corrected value, exactly as the visitor stated it' },
                },
                required: ['field', 'value'],
            },
        },
    ];
}

// One-shot instructions for reply.create — see sendInterviewHandoff for why
// this is needed at all (session.update alone doesn't make the agent speak).
function buildInterviewHandoffInstructions() {
    const ocrName = state.ocrData?.name || '';
    return ocrName
        ? `Say thank you to the visitor by name — "Thank you, Mr./Ms. ${ocrName}!" — then read back the ID scan data and ask "Is this correct?" Wait for their answer before doing anything else.`
        : `Let the visitor know their document couldn't be read clearly, so you'll continue with a few quick questions instead, then ask the first question from the list.`;
}

// Scanning is done (OCR succeeded, failed, or was abandoned via timeout) —
// move to the interview phase. Shared by the questions_ready handler and the
// OCR-timeout fallback in uploadAndProcess, so both actually reach the
// interview instead of leaving the agent stuck on the greeting-only prompt.
function proceedToInterview() {
    state.scanCompleted = true;
    state.pendingInterviewHandoff = true;
    dbg('scanCompleted=true aaiReady=' + state.aaiReady + ' voiceConnecting=' + state.voiceConnecting);
    if (state.aaiReady) {
        dbg('Voice already connected, switching to interview via session.update');
        state.pendingInterviewHandoff = false;
        sendInterviewHandoff();
    } else if (!state.voiceConnecting) {
        dbg('Voice not connected and not connecting — starting now');
        connectToAssemblyAI().catch(err => {
            dbg('Voice failed: ' + err.message);
            updateStatus('Voice failed: ' + err.message);
        });
    } else {
        dbg('Voice is connecting — interview handoff will happen on session.ready');
    }
}

function sendInterviewHandoff() {
    if (state.aaiWs?.readyState !== 1) return;
    dbg('Sending interview handoff via session.update');
    state.micMuted = false; // scan is confirmed — let the mic through again
    state.aaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
            system_prompt: buildInterviewPrompt(),
            tools: buildInterviewTools(),
            // Real conversation starts here (mic just unmuted) — this is the
            // point where noise-robust turn detection actually matters most.
            input: { turn_detection: TURN_DETECTION },
        },
    }));
    // AssemblyAI docs: session.update alone never makes the agent speak — it
    // stays silent until the next user utterance. The visitor has no reason
    // to speak first right after uploading a photo, so nudge the agent to
    // proactively confirm the scan via reply.create's one-shot instructions
    // (these don't alter system_prompt, they just steer this one reply).
    state.aaiWs.send(JSON.stringify({
        type: 'reply.create',
        instructions: buildInterviewHandoffInstructions(),
    }));
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function addWorklet(ctx, code, name) {
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    return new AudioWorkletNode(ctx, name);
}

function displayOCRResult(fields) {
    const c = elements.ocrFields; if (!c) return; c.innerHTML = '';
    const labels = { name: 'Name', full_name: 'Name', id_number: 'ID Number', date_of_birth: 'DOB', address: 'Address' };
    for (const [k, v] of Object.entries(fields || {})) {
        if (!v) continue;
        const r = document.createElement('div'); r.className = 'field-row';
        r.innerHTML = `<span class="field-label">${labels[k] || k}</span><span class="field-value">${v}</span>`;
        c.appendChild(r);
    }
    elements.ocrResult?.classList.remove('hidden');
    updateStatus('Document scanned');
}

function showSummary(answers, ocr) {
    updateStatus('Review your check-in');
    let s = '📋 Summary:\n';
    if (answers) for (const [q, a] of Object.entries(answers)) s += `• ${q}: ${a}\n`;
    if (ocr) { s += '\n📄 Document:\n'; for (const [k, v] of Object.entries(ocr)) if (v) s += `• ${k}: ${v}\n`; }
    addMessage('agent', s);
}

function showDone(registrationId) {
    updateStatus('Check-in complete'); showStep('confirm');
    if (elements.confirmMessage) elements.confirmMessage.textContent = 'Your check-in is complete!';
    if (elements.confirmId) elements.confirmId.textContent = `Registration ID: ${registrationId}`;
    cleanupAudio();
}

function cleanupAudio() {
    state.aaiReady = false;
    state.voiceConnecting = false;
    if (state.aaiWs?.readyState === 1) {
        try { state.aaiWs.send(JSON.stringify({ type: 'session.end' })); } catch (_) {}
        setTimeout(() => { try { state.aaiWs?.close(); } catch (_) {} state.aaiWs = null; }, 2000);
    } else {
        state.aaiWs = null;
    }
    state.playback?.port.postMessage('stop');
    state.mic?.getTracks().forEach(t => t.stop());
    state.captureCtx?.close(); state.playbackCtx?.close();
    state.captureCtx = state.playbackCtx = state.playback = state.mic = null;
}

// ── Events ─────────────────────────────────────────────────────────────────

function initEventListeners() {
    // Take a photo (capture="environment" opens the device's native camera
    // app directly — far more reliable inside the Telegram WebView than an
    // in-page getUserMedia preview, which is why earlier attempts at that
    // were reverted) or pick an existing one. Both feed the same upload path.
    $('camera-capture')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) uploadAndProcess(file, file.type);
        e.target.value = '';
    });
    $('file-upload')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) uploadAndProcess(file, file.type);
        e.target.value = '';
    });
    elements.btnNewVisitor?.addEventListener('click', () => {
        state.answers = {}; state.ocrData = null;
        // Without this reset, a new visitor whose business also requires an
        // ID scan would skip straight to the interview prompt on connect,
        // since scanCompleted/requiresIdScan would still carry over true
        // from the previous visitor's finished session.
        state.scanCompleted = false; state.pendingInterviewHandoff = false; state.requiresIdScan = false;
        if (elements.transcriptMessages) elements.transcriptMessages.innerHTML = '';
        cleanupAudio(); if (state.doWs) { state.doWs.close(); state.doWs = null; } connectToDO();
    });
    window.addEventListener('beforeunload', () => { cleanupAudio(); state.doWs?.close(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

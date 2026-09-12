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
    businessId: null, businessName: '', doWs: null, aaiWs: null,
    captureCtx: null, playbackCtx: null, playback: null, mic: null,
    aaiReady: false, questions: [], answers: {}, ocrData: null,
    requiresIdScan: false, cameraFacing: 'environment', mediaStream: null,
    voiceConnecting: false,
};

const $ = (id) => document.getElementById(id);
const elements = {
    stepScan: $('step-scan'), stepVoice: $('step-voice'), stepConfirm: $('step-confirm'),
    cameraContainer: $('camera-container'), cameraPreview: $('camera-preview'),
    cameraCanvas: $('camera-canvas'), cameraControls: $('camera-controls'),
    ocrResult: $('ocr-result'), ocrFields: $('ocr-fields'), ocrLoading: $('ocr-loading'),
    scanActions: $('scan-actions'), transcriptMessages: $('transcript-messages'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    btnNewVisitor: $('btn-new-visitor'), confirmMessage: $('confirm-message'), confirmId: $('confirm-id'),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function updateStatus(text) {
    if (elements.statusText) elements.statusText.textContent = text;
    if (elements.statusDot) elements.statusDot.className = 'status-dot ' + (text.includes('Listening') ? 'listening' : text.includes('Speaking') ? 'speaking' : '');
}

function showStep(step) {
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
    const tg = CONFIG.tgApp; if (!tg) return;
    tg.ready(); tg.expand();
    const sp = (tg.initDataUnsafe || {}).start_param || '';
    if (sp) state.businessId = sp;
}

async function init() {
    initTelegram();
    if (!state.businessId) state.businessId = 'clinic-main';
    initEventListeners();
    updateStatus('Connecting...');
    await connectToDO();
}

// ── DO WebSocket ───────────────────────────────────────────────────────────

async function connectToDO() {
    const wsUrl = `${CONFIG.API_URL.replace('https://', 'wss://')}/api/ws/${crypto.randomUUID()}`;
    state.doWs = new WebSocket(wsUrl);

    state.doWs.onopen = () => {
        state.doWs.send(JSON.stringify({ type: 'start', business_id: state.businessId }));
    };

    state.doWs.onmessage = (e) => handleDOMessage(JSON.parse(e.data));
    state.doWs.onerror = () => updateStatus('Connection error');
    state.doWs.onclose = () => console.log('DO disconnected');
}

function handleDOMessage(msg) {
    console.log('DO ←', msg.type);

    switch (msg.type) {
        case 'welcome':
            state.businessName = msg.business_name || '';
            state.requiresIdScan = msg.requires_id_scan;
            state.questions = msg.questions || [];
            const ht = $('header-title');
            if (ht) ht.textContent = `Welcome to ${state.businessName}`;
            updateStatus(`Welcome to ${state.businessName}!`);
            // If no scan required, go straight to voice
            if (!state.requiresIdScan) {
                showStep('voice');
                connectToAssemblyAI();
            }
            break;

        case 'request_camera':
            updateStatus('Please scan your ID');
            showStep('scan');
            startCamera();
            break;

        case 'ocr_result':
            state.ocrData = msg.fields;
            displayOCRResult(msg.fields);
            break;

        case 'questions_ready':
            clearTimeout(state.ocrTimeout);
            state.questions = msg.questions || state.questions;
            state.ocrData = msg.ocr_data || state.ocrData;
            state.businessName = msg.business_name || state.businessName;
            stopCamera();
            updateStatus('Connecting voice...');
            showStep('voice');
            connectToAssemblyAI().catch(err => {
                console.error('Voice failed:', err);
                updateStatus('Voice failed — try refreshing');
            });
            break;

        case 'state':
            updateStatus(`Question ${msg.index + 1}/${msg.total}: ${msg.question}`);
            break;

        case 'summary': showSummary(msg.answers, msg.ocr); break;
        case 'checkin_complete': showDone(msg.registration_id); break;
        case 'error': updateStatus('Error: ' + msg.message); break;
    }
}

// ── Camera ─────────────────────────────────────────────────────────────────

async function startCamera() {
    try {
        if (state.mediaStream) state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: state.cameraFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        elements.cameraPreview.srcObject = state.mediaStream;
        elements.cameraContainer?.classList.remove('hidden');
        elements.cameraControls?.classList.remove('hidden');
    } catch (err) {
        console.log('Camera not available:', err.message);
        elements.cameraContainer?.classList.add('hidden');
        elements.cameraControls?.classList.add('hidden');
    }
}

function stopCamera() { if (state.mediaStream) { state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null; } }

async function captureFromCamera() {
    const v = elements.cameraPreview, c = elements.cameraCanvas;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    await uploadAndProcess(blob, 'image/jpeg');
}

// ── Upload ─────────────────────────────────────────────────────────────────

async function uploadAndProcess(blobOrFile, contentType) {
    elements.ocrLoading?.classList.remove('hidden');
    updateStatus('Uploading...');

    try {
        const urlResp = await fetch(`${CONFIG.API_URL}/api/upload-url`);
        if (!urlResp.ok) throw new Error('Upload URL failed');
        const { upload_url, r2_key } = await urlResp.json();

        const putResp = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': contentType || 'image/jpeg' }, body: blobOrFile });
        if (!putResp.ok) throw new Error('Upload failed');

        if (state.doWs?.readyState !== 1) throw new Error('Connection lost');
        state.doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key }));
        updateStatus('Processing document...');

        // Safety timeout: if DO doesn't respond in 15s, skip OCR and go to voice
        state.ocrTimeout = setTimeout(() => {
            console.warn('OCR timeout — going to voice without OCR');
            updateStatus('Connecting voice...');
            showStep('voice');
            connectToAssemblyAI().catch(err => {
                console.error('Voice failed:', err);
                updateStatus('Voice failed — try refreshing');
            });
        }, 15000);

    } catch (err) {
        console.error('Upload error:', err);
        updateStatus('Upload failed: ' + err.message);
        elements.ocrLoading?.classList.add('hidden');
    }
}

// ── AssemblyAI Voice ───────────────────────────────────────────────────────

async function connectToAssemblyAI() {
    // Guard: prevent double-calling (OCR timeout + questions_ready race)
    if (state.voiceConnecting || state.aaiWs) {
        console.log('Already connecting/connected to voice, skipping');
        return;
    }
    state.voiceConnecting = true;

    console.log('Connecting to AssemblyAI...');

    // 1. Get token
    let token;
    try {
        const tokenResp = await fetch(`${CONFIG.API_URL}/api/token`);
        if (!tokenResp.ok) throw new Error(`Token HTTP ${tokenResp.status}`);
        const data = await tokenResp.json();
        token = data.token;
        if (!token) throw new Error('No token in response: ' + JSON.stringify(data));
        console.log('Token received');
    } catch (e) {
        state.voiceConnecting = false;
        throw new Error('Token fetch failed: ' + e.message);
    }

    // 2. Set up audio
    state.captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
    state.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
    // Resume both contexts — mobile browsers (esp. Telegram WebView) start them suspended
    await state.captureCtx.resume();
    await state.playbackCtx.resume();
    console.log('AudioContexts resumed, state:', state.captureCtx.state, state.playbackCtx.state);

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.mic = stream;
    console.log('Mic granted');

    const source = state.captureCtx.createMediaStreamSource(stream);
    const capture = await addWorklet(state.captureCtx, CAPTURE_WORKLET, 'capture');
    source.connect(capture);
    // NOTE: do NOT connect capture to destination — it only posts PCM via port.onmessage,
    // connecting to speakers causes feedback and can block the playback AudioContext on mobile.

    state.playback = await addWorklet(state.playbackCtx, PLAYBACK_WORKLET, 'playback');
    state.playback.connect(state.playbackCtx.destination);

    // 3. Connect to AssemblyAI
    state.aaiWs = new WebSocket(`${CONFIG.VOICE_AGENT_URL}?token=${token}`);

    capture.port.onmessage = ({ data }) => {
        if (!state.aaiReady || state.aaiWs?.readyState !== 1) return;
        const bytes = new Uint8Array(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        state.aaiWs.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }));
    };

    state.aaiWs.onopen = () => {
        console.log('AAI connected, sending session.update');

        const ocrName = state.ocrData?.name || '';
        const ocrFields = state.ocrData ? Object.entries(state.ocrData).filter(([k, v]) => v && k !== 'name').map(([k, v]) => `${k}: ${v}`).join(', ') : '';

        const ocrSection = ocrName
            ? `\nOCR DATA:\n- Name: ${ocrName}${ocrFields ? '\n- ' + ocrFields : ''}\n\nGreet by name, read back data, ask "Is this correct?", wait for confirmation, then proceed with questions.`
            : '';

        const questionsList = (state.questions || []).map((q, i) => `${i + 1}. "${q.text}" (field: ${q.field})`).join('\n');

        const systemPrompt = `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.

INTRODUCTION:
Say: "Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today."
${ocrSection}

QUESTIONS (ask ONE AT A TIME, in order):
${questionsList}

FLOW:
${ocrSection ? '1. Confirm OCR data first' : '1. Start with questions'}
2. Ask each question, wait for answer, confirm briefly ("Got it", "Understood", "Perfect")
3. After confirming, call submit_answer tool with their answer
4. Move to next question
5. After all questions, summarize and ask "Is everything correct?"

RULES:
- Speak in the visitor's language
- Keep sentences short — this is voice
- Never generate your own questions
- Call submit_answer only for confirmed answers`;

        state.aaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                system_prompt: systemPrompt,
                greeting: ocrName
                    ? `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna. I see from your ID that your name is ${ocrName}. Let me confirm your details.`
                    : `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today. Let's get you checked in.`,
                output: { type: 'audio', voice: 'anna' },
                tools: [{
                    type: 'function',
                    name: 'submit_answer',
                    description: 'Submit the visitor answer for the current question.',
                    parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
                }],
            },
        }));
    };

    state.aaiWs.onmessage = ({ data }) => handleAAILogic(JSON.parse(data));
    state.aaiWs.onerror = (err) => {
        console.error('AAI WebSocket error:', err);
        updateStatus('Voice connection error');
        state.voiceConnecting = false;
    };
    state.aaiWs.onclose = (ev) => {
        console.log('AAI WebSocket closed, code:', ev.code, 'reason:', ev.reason);
        state.aaiReady = false;
        state.voiceConnecting = false;
        state.aaiWs = null;
        if (ev.code !== 1000) updateStatus('Voice disconnected — ' + (ev.reason || 'closed'));
    };
}

function handleAAILogic(msg) {
    console.log('AAI ←', msg.type, msg);
    switch (msg.type) {
        case 'session.ready':
            state.aaiReady = true;
            state.voiceConnecting = false;
            updateStatus('Listening...');
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
        case 'reply.done': updateStatus('Listening...'); if (msg.status === 'interrupted') state.playback?.port.postMessage('stop'); break;
        case 'transcript.user': addMessage('user', msg.text); break;
        case 'transcript.agent': addMessage('agent', msg.text); break;
        case 'session.ended': state.aaiReady = false; break;
        case 'session.error': updateStatus('Voice error: ' + msg.message); break;

        case 'tool.call':
            if (msg.name === 'submit_answer') {
                const answer = msg.arguments?.answer || '';
                if (state.doWs?.readyState === 1) state.doWs.send(JSON.stringify({ type: 'user_transcript', text: answer }));
                if (state.aaiWs?.readyState === 1) state.aaiWs.send(JSON.stringify({ type: 'tool.result', call_id: msg.call_id, result: JSON.stringify({ success: true }) }));
            }
            break;
        default:
            console.log('Unhandled AAI message type:', msg.type, msg);
            break;
    }
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
    $('btn-switch-camera')?.addEventListener('click', () => { state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user'; startCamera(); });
    $('btn-capture')?.addEventListener('click', captureFromCamera);
    $('file-upload-camera')?.addEventListener('change', (e) => { if (e.target.files?.[0]) uploadAndProcess(e.target.files[0], e.target.files[0].type); });
    $('file-upload-gallery')?.addEventListener('change', (e) => { if (e.target.files?.[0]) uploadAndProcess(e.target.files[0], e.target.files[0].type); });
    elements.btnNewVisitor?.addEventListener('click', () => {
        state.answers = {}; state.ocrData = null;
        if (elements.transcriptMessages) elements.transcriptMessages.innerHTML = '';
        cleanupAudio(); if (state.doWs) { state.doWs.close(); state.doWs = null; } connectToDO();
    });
    window.addEventListener('beforeunload', () => { cleanupAudio(); state.doWs?.close(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

import { prepareAudio } from './audio-lifecycle.js';

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

// AssemblyAI's defaults (vad_threshold 0.5, barge-in enabled) are quick to
// treat any ambient sound as an interruption — and once interrupted, the
// reply is simply gone (no resume), so the agent re-decides what to say
// next, which shows up as it re-asking the same question. vad_threshold is
// still raised for turn-taking accuracy in general, but the actual fix for
// noise-triggered interruptions is interrupt_response: false — the agent
// finishes speaking no matter what it hears, full stop. Its replies here
// are short (one question, one summary line), so the visitor waiting for it
// to finish costs little, and it's a full disable rather than a threshold
// tweak (verified live against AssemblyAI's API: accepted, reaches
// session.ready). min_silence/max_silence are deliberately left unset
// (adaptive end-of-turn timing).
const TURN_DETECTION = { vad_threshold: 0.65, interruption_delay: 600, interrupt_response: false };

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
    requiresIdScan: false, voiceConnecting: false, pendingToolResults: [], checkinDone: false,
    documentsUploadedCount: 0,
    audioAbort: null, startPending: false, voiceGeneration: 0,
    captureNode: null, captureSource: null, voiceTimer: null,
    lastAAIEvent: null, replyDoneSinceLastFlush: false, replyNumber: 0, toolCalls: new Map(), operations: new Map(),
    interviewHandoffGeneration: -1, fsmState: 'idle', resumed: false,
    currentQuestionIndex: 0, manualConfirmOperationId: null, documentsOperationId: null,
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
    // Per-business voice config, set from the DO's welcome message.
    welcomeMessage: '', voiceId: 'anna', voicePersona: '',
    cameraStream: null,
};

const $ = (id) => document.getElementById(id) || document.querySelector(`.${id}`);
const elements = {
    stepStart: $('step-start'), btnStart: $('btn-start'),
    stepScan: $('step-scan'), stepVoice: $('step-voice'), stepConfirm: $('step-confirm'),
    stepDocuments: $('step-documents'),
    summaryActions: $('summary-actions'), btnConfirmSummary: $('btn-confirm-summary'),
    ocrResult: $('ocr-result'), ocrFields: $('ocr-fields'), ocrLoading: $('ocr-loading'),
    scanActions: $('scan-actions'), transcriptMessages: $('transcript-messages'),
    transcriptScroll: $('transcript-scroll'),
    statusDot: $('status-dot'), statusText: $('status-text'),
    btnNewVisitor: $('btn-new-visitor'), confirmMessage: $('confirm-message'), confirmId: $('confirm-id'),
    documentsPrompt: $('documents-prompt'), documentsUpload: $('documents-upload'),
    documentsUploadedCount: $('documents-uploaded-count'), btnDocumentsContinue: $('btn-documents-continue'),
    btnTakePhoto: $('btn-take-photo'), cameraPreviewContainer: $('camera-preview-container'),
    cameraPreview: $('camera-preview'), btnCapture: $('btn-capture'), btnCancelCamera: $('btn-cancel-camera'),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function updateStatus(text) {
    dbg('STATUS: ' + text);
    if (elements.statusText) elements.statusText.textContent = text;
    if (elements.statusDot) elements.statusDot.className = 'status-dot ' + (text.includes('Listening') ? 'listening' : text.includes('Speaking') ? 'speaking' : '');
}

function showStep(step) {
    dbg('STEP → ' + step);
    if (step !== 'scan') stopCamera();
    [{ scan: elements.stepScan, voice: elements.stepVoice, documents: elements.stepDocuments, confirm: elements.stepConfirm }].forEach(steps => {
        for (const [k, el] of Object.entries(steps)) if (el) el.classList.toggle('hidden', k !== step);
    });
}

function addMessage(who, text) {
    if (!elements.transcriptMessages) return;
    const div = document.createElement('div'); div.className = `message ${who}`; div.textContent = text;
    elements.transcriptMessages.appendChild(div);
    // The scrollable element is .transcript (the wrapper), not
    // .transcript-messages itself — that one has no overflow/fixed height,
    // so setting its own scrollTop was always a no-op and the page never
    // auto-scrolled as new messages came in.
    const scroller = elements.transcriptScroll;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// ── Init ───────────────────────────────────────────────────────────────────

function initTelegram() {
    const tg = CONFIG.tgApp; if (!tg) { dbg('No Telegram WebApp object'); return; }
    tg.ready(); tg.expand();
    // Telegram only auto-populates initDataUnsafe.start_param for Direct Link
    // Mini Apps (t.me/<bot>?startapp=...). This app is instead opened via a
    // regular `web_app` inline button (see handleTelegramUpdate in
    // worker.js), which never gets that treatment — the business id has to
    // be embedded in the button's own URL and read back from location.search.
    const urlParam = new URLSearchParams(location.search).get('start_param') || '';
    const sp = urlParam || (tg.initDataUnsafe || {}).start_param || '';
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
    // Deliberately does NOT connect to anything yet. Browsers only let an
    // AudioContext actually activate (and getUserMedia behaves best) inside
    // the call stack of a real user gesture — starting everything here, on
    // page load, left audio stuck "suspended" forever with no visible error
    // (confirmed via a real browser test). Everything below waits for the
    // visitor to tap Start.
    elements.btnStart?.addEventListener('click', startCheckin);
}

async function startCheckin() {
    if (state.startPending) return;
    cleanupAudio();
    state.startPending = true;
    if (elements.btnStart) { elements.btnStart.disabled = true; elements.btnStart.textContent = 'Starting…'; }
    try {
        await primeAudio();
        elements.stepStart?.classList.add('hidden');
        updateStatus('Connecting...');
        await connectToDO();
    } catch (err) {
        cleanupAudio();
        showVoiceRetry('Could not start: ' + err.message);
    } finally {
        state.startPending = false;
    }
}

function showVoiceRetry(message) {
    if (state.checkinDone) return;
    updateStatus(message);
    elements.stepStart?.classList.remove('hidden');
    if (elements.btnStart) {
        elements.btnStart.disabled = false;
        elements.btnStart.textContent = state.sessionId ? '🎤 Resume conversation' : '🎤 Tap to Start';
    }
}

async function primeAudio() {
    const controller = new AbortController();
    state.audioAbort = controller;
    const audio = await prepareAudio({ sampleRate: WIRE_RATE, signal: controller.signal });
    if (state.audioAbort !== controller || controller.signal.aborted) {
        audio.mic.getTracks().forEach(track => track.stop());
        await Promise.allSettled([audio.captureCtx.close(), audio.playbackCtx.close()]);
        throw new Error('Audio start cancelled');
    }
    Object.assign(state, audio);
}

// ── DO WebSocket ───────────────────────────────────────────────────────────

const DO_RECONNECT_MAX_ATTEMPTS = 5;
let doReconnectAttempts = 0;
let doReconnectTimer = null;

function wireDoWs(isResume) {
    const ws = state.doWs;
    const isCurrent = () => state.doWs === ws;
    // Timeout: if WebSocket doesn't open in 10s, show error
    const connectTimeout = setTimeout(() => {
        if (isCurrent() && ws.readyState !== WebSocket.OPEN) {
            state.doWs = null;
            ws.close();
            cleanupAudio();
            showVoiceRetry('Connection timed out. Check the network and tap to reconnect.');
        }
    }, 10000);

    ws.onopen = () => {
        if (!isCurrent()) return;
        clearTimeout(connectTimeout);
        doReconnectAttempts = 0; // back to a clean slate once we're actually connected
        dbg('DO WebSocket OPENED ✓' + (isResume ? ' (resume)' : ''));
        // "resume" re-announces wherever the FSM already is without resetting
        // progress — resending "start" here would force the DO back into
        // scanning_doc/asking_questions and re-ask for a scan or a question
        // the visitor already got past.
        const msg = isResume ? { type: 'resume', business_id: state.businessId } : { type: 'start', business_id: state.businessId };
        dbg('Sending to DO: ' + JSON.stringify(msg));
        state.doWs.send(JSON.stringify(msg));
        updateStatus(isResume ? 'Reconnected' : 'Loading business...');
    };

    ws.onmessage = (e) => {
        if (!isCurrent()) return;
        // Do not log response bodies: they can contain visitor information.
        try {
            const msg = JSON.parse(e.data);
            handleDOMessage(msg);
        } catch (err) {
            dbg('ERROR parsing DO message: ' + err.message);
        }
    };

    ws.onerror = () => {
        if (!isCurrent()) return;
        clearTimeout(connectTimeout);
        state.doWs = null;
        ws.close();
        cleanupAudio();
        showVoiceRetry('Connection failed. Tap to reconnect.');
    };

    ws.onclose = (ev) => {
        if (!isCurrent()) return;
        clearTimeout(connectTimeout);
        dbg('DO WebSocket CLOSED code=' + ev.code + ' reason=' + (ev.reason || '(none)'));
        // 1000/1005 are the normal ways this closes (the DO's own 2s-delayed
        // close after checkin_complete, or a clean client-initiated close) —
        // never retry those, and never retry once the check-in already
        // finished. Anything else — most commonly 1006, "abnormal closure",
        // which is what a flaky mobile connection or a backgrounded tab
        // produces mid-interview — is worth reconnecting for instead of
        // leaving the visitor stuck silently on the voice screen.
        rejectPendingOperations('Connection lost. The result is unconfirmed; retry after reconnecting.');
        if (state.checkinDone) return;
        if (ev.code === 1000 || ev.code === 1005) {
            cleanupAudio();
            showVoiceRetry('Connection closed. Tap to reconnect.');
            return;
        }
        state.micMuted = true;
        if (doReconnectAttempts >= DO_RECONNECT_MAX_ATTEMPTS) {
            cleanupAudio();
            showVoiceRetry('Connection lost. Tap to reconnect.');
            return;
        }
        doReconnectAttempts++;
        const delay = Math.min(1000 * 2 ** (doReconnectAttempts - 1), 8000);
        updateStatus(`Connection lost — reconnecting… (${doReconnectAttempts}/${DO_RECONNECT_MAX_ATTEMPTS})`);
        dbg(`DO reconnect attempt ${doReconnectAttempts} in ${delay}ms`);
        clearTimeout(doReconnectTimer);
        doReconnectTimer = setTimeout(reconnectToDO, delay);
    };
}

// Store only a short-lived reference, scoped to its business. No visitor data.
const SESSION_STORAGE_KEY = 'vobb_session_v2';
const SESSION_TTL_MS = 10 * 60 * 1000;
const OPERATION_TIMEOUT_MS = 10000;

async function connectToDO() {
    let isResume = false;
    let stored;
    try { stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null'); } catch (_) {}
    if (stored && typeof stored.id === 'string' && stored.businessId === state.businessId
            && Number.isFinite(stored.expiresAt) && stored.expiresAt > Date.now()) {
        state.sessionId = stored.id;
        isResume = true;
    } else {
        state.sessionId = crypto.randomUUID();
        state.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
        try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
            id: state.sessionId, businessId: state.businessId, expiresAt: state.sessionExpiresAt,
        })); } catch (_) {}
    }
    if (isResume) state.sessionExpiresAt = stored.expiresAt;
    const old = state.doWs;
    state.doWs = null;
    old?.close();
    clearTimeout(doReconnectTimer);
    const wsUrl = `${CONFIG.API_URL.replace('https://', 'wss://')}/api/ws/${state.sessionId}`;
    state.doWs = new WebSocket(wsUrl);
    wireDoWs(isResume);
}

function reconnectToDO() {
    if (!state.sessionId || state.checkinDone) return;
    const wsUrl = `${CONFIG.API_URL.replace('https://', 'wss://')}/api/ws/${state.sessionId}`;
    state.doWs = new WebSocket(wsUrl);
    wireDoWs(true);
}

function rejectPendingOperations(message) {
    for (const operation of state.operations.values()) {
        clearTimeout(operation.timer);
        operation.reject(new Error(message));
    }
    state.operations.clear();
}

function requestOperation(type, payload = {}, operationId = crypto.randomUUID()) {
    const fingerprint = JSON.stringify({ type, payload });
    const existing = state.operations.get(operationId);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise
        : Promise.reject(new Error('Operation ID was reused for different data'));
    if (state.doWs?.readyState !== 1) return Promise.reject(new Error('Not connected. Reconnect and try again.'));
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const operation = { promise, resolve, reject, fingerprint, sessionId: state.sessionId };
    operation.timer = setTimeout(() => {
        if (state.operations.get(operationId) !== operation) return;
        state.operations.delete(operationId);
        reject(new Error('Server confirmation timed out. The result is unconfirmed; retry to check it.'));
    }, OPERATION_TIMEOUT_MS);
    state.operations.set(operationId, operation);
    try { state.doWs.send(JSON.stringify({ ...payload, type, operation_id: operationId })); }
    catch (_) {
        clearTimeout(operation.timer); state.operations.delete(operationId);
        reject(new Error('Could not send the operation. Reconnect and try again.'));
    }
    return promise;
}

function applySessionDetails(msg) {
    state.businessName = msg.business_name || '';
    state.requiresIdScan = !!msg.requires_id_scan;
    state.questions = msg.questions || [];
    state.welcomeMessage = msg.welcome_message || `Welcome to ${state.businessName}`;
    state.voiceId = msg.voice_id || 'anna';
    state.voicePersona = msg.voice_persona || '';
    const heading = $('header-title');
    if (heading) heading.textContent = `Welcome to ${state.businessName}`;
    updateBusinessIcon(msg.business_type);
}

function updateBusinessIcon(businessType) {
    const icons = { clinic: '🏥', lawyer: '⚖️', hotel: '🏨', office: '🏢', event: '🎪' };
    const icon = document.querySelector('.logo-icon');
    if (icon) icon.textContent = icons[businessType] || '🏢';
}

function restoreSession(msg) {
    if (msg.business_id !== state.businessId) {
        rejectPendingOperations('Session belongs to another business');
        cleanupAudio();
        const ws = state.doWs; state.doWs = null; ws?.close();
        try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (_) {}
        state.sessionId = null;
        showVoiceRetry('Session mismatch. Tap Start to begin again.');
        return;
    }
    applySessionDetails(msg);
    state.answers = msg.answers || {};
    state.ocrData = msg.ocr_data || {};
    state.currentQuestionIndex = msg.current_question_index || 0;
    state.fsmState = msg.state;
    state.micMuted = msg.state === 'scanning_doc' || msg.state === 'uploading_documents';
    state.resumed = true;
    state.scanCompleted = msg.state !== 'scanning_doc';
    if (state.aaiReady) {
        // Must resend tools/input.turn_detection too — a session.update that
        // only touches system_prompt silently drops back to AssemblyAI's own
        // defaults (barge-in on, lower vad_threshold), which is exactly what
        // made the agent cut off on background noise after any reconnect.
        state.aaiWs?.send(JSON.stringify({
            type: 'session.update',
            session: {
                system_prompt: buildInterviewPrompt(),
                tools: buildInterviewTools(),
                input: { turn_detection: TURN_DETECTION, keyterms: buildKeyterms() },
            },
        }));
    } else if (!state.voiceConnecting && msg.state !== 'done') {
        state.pendingInterviewHandoff = msg.state === 'asking_questions' || msg.state === 'confirming';
        connectToAssemblyAI().catch(err => { cleanupAudio(); showVoiceRetry('Voice failed: ' + err.message); });
    }
}

function handleDOMessage(msg) {
    dbg('DO ← type=' + msg.type);

    switch (msg.type) {
        case 'operation_result': {
            const operation = state.operations.get(msg.operation_id);
            if (!operation || operation.sessionId !== state.sessionId) break;
            clearTimeout(operation.timer);
            state.operations.delete(msg.operation_id);
            if (msg.success === true) operation.resolve(msg);
            else {
                const error = new Error(msg.error || 'Server rejected the operation');
                error.confirmedFailure = true;
                error.retryable = msg.retryable === true;
                operation.reject(error);
            }
            break;
        }
        case 'session_restored': restoreSession(msg); break;
        case 'welcome':
            state.fsmState = msg.requires_id_scan ? 'scanning_doc' : 'asking_questions';
            state.resumed = false;
            state.businessName = msg.business_name || '';
            state.requiresIdScan = msg.requires_id_scan;
            state.questions = msg.questions || [];
            state.welcomeMessage = msg.welcome_message || `Welcome to ${state.businessName}!`;
            state.voiceId = msg.voice_id || 'anna';
            state.voicePersona = msg.voice_persona || '';
            dbg('Welcome: biz=' + state.businessName + ' requiresIdScan=' + state.requiresIdScan + ' questions=' + state.questions.length + ' voiceId=' + state.voiceId);
            const ht = $('header-title');
            if (ht) ht.textContent = `Welcome to ${state.businessName}`;
            updateBusinessIcon(msg.business_type);
            updateStatus(`Welcome to ${state.businessName}!`);
            // Connect voice immediately so Anna speaks the greeting
            showStep(state.requiresIdScan ? 'scan' : 'voice');
            connectToAssemblyAI().catch(err => {
                dbg('Voice failed: ' + err.message);
                cleanupAudio(); showVoiceRetry('Voice failed: ' + err.message);
            });
            break;

        case 'request_camera':
            state.fsmState = 'scanning_doc';
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
            state.fsmState = 'asking_questions';
            dbg('Questions ready received, clearing OCR timeout');
            clearTimeout(state.ocrTimeout);
            state.questions = msg.questions || state.questions;
            state.ocrData = msg.ocr_data || state.ocrData;
            state.businessName = msg.business_name || state.businessName;
            dbg('Questions count: ' + state.questions.length);
            showStep('voice');
            proceedToInterview();
            break;

        case 'state':
            state.currentQuestionIndex = msg.index;
            state.fsmState = msg.state || 'asking_questions';
            showStep('voice');
            dbg('Question state: ' + (msg.index + 1) + '/' + msg.total + ': ' + msg.question);
            updateStatus(`Question ${msg.index + 1}/${msg.total}: ${msg.question}`);
            break;

        case 'request_documents':
            state.fsmState = 'uploading_documents';
            dbg('Request documents received: ' + msg.prompt);
            if (elements.documentsPrompt) elements.documentsPrompt.textContent = msg.prompt || '';
            state.micMuted = true; // this step is UI-driven, not a voice exchange
            showStep('documents');
            announceDocumentsStep(msg.prompt);
            break;

        case 'summary': showSummary(msg.answers, msg.ocr); break;
        case 'checkin_complete': showDone(msg.registration_id); break;

        case 'error':
            dbg('DO ERROR: ' + msg.message);
            // A resume attempt against a stored sessionId whose DO session
            // already expired/was wiped (the 10-minute alarm, or just never
            // existed) — the stored id is now useless, so drop it and start
            // clean instead of getting stuck on a permanent error.
            if (msg.message === 'No active session to resume') {
                dbg('Stored session is gone — clearing it and starting fresh');
                try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (_) {}
                const old = state.doWs; state.doWs = null; old?.close();
                connectToDO();
                break;
            }
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
        dbg('Upload complete');

        if (state.doWs?.readyState !== 1) {
            dbg('DO NOT READY: readyState=' + (state.doWs?.readyState || 'null'));
            throw new Error('DO connection lost');
        }
        const idMsg = { type: 'id_uploaded', r2_key };
        dbg('Sending uploaded document reference to server');
        state.doWs.send(JSON.stringify(idMsg));
        updateStatus('Processing document...');

        // The server owns the scan transition. A slow OCR must not start an interview while it is still scanning.
        state.ocrTimeout = setTimeout(() => {
            updateStatus('Document processing is taking longer than usual. Please wait for the scan result.');
        }, 15000);

    } catch (err) {
        dbg('Upload error: ' + err.message);
        updateStatus('Upload failed: ' + err.message);
        elements.ocrLoading?.classList.add('hidden');
    }
}

// ── Camera (getUserMedia) ─────────────────────────────────────────────────

function stopCamera() {
    if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(track => track.stop());
        state.cameraStream = null;
    }
    if (elements.cameraPreview) elements.cameraPreview.srcObject = null;
    elements.cameraPreviewContainer?.classList.add('hidden');
    elements.btnTakePhoto?.classList.remove('hidden');
}

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        state.cameraStream = stream;
        if (elements.cameraPreview) elements.cameraPreview.srcObject = stream;
        elements.cameraPreviewContainer?.classList.remove('hidden');
        elements.btnTakePhoto?.classList.add('hidden');
    } catch (err) {
        dbg('getUserMedia failed, falling back to file input: ' + err.message);
        // Fall back to file input — create a hidden one on the fly
        const fallback = document.createElement('input');
        fallback.type = 'file'; fallback.accept = 'image/*';
        fallback.style.display = 'none';
        document.body.appendChild(fallback);
        fallback.addEventListener('change', () => {
            const file = fallback.files?.[0];
            if (file) uploadAndProcess(file, file.type);
            fallback.remove();
        }, { once: true });
        fallback.click();
    }
}

function capturePhoto() {
    const video = elements.cameraPreview;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stopCamera();
    canvas.toBlob((blob) => {
        if (blob) uploadAndProcess(blob, 'image/jpeg');
    }, 'image/jpeg', 0.85);
}

// ── AssemblyAI Voice ───────────────────────────────────────────────────────

async function connectToAssemblyAI() {
    // Guard: prevent double-calling (OCR timeout + questions_ready race)
    if (state.voiceConnecting || state.aaiWs) {
        dbg('Voice already connecting/connected — SKIPPING');
        return;
    }
    state.voiceConnecting = true;
    const generation = state.voiceGeneration;
    const current = () => generation === state.voiceGeneration;
    const captureCtx = state.captureCtx, playbackCtx = state.playbackCtx;
    // Cover token retrieval and worklet setup as well as the WebSocket handshake.
    const aaiTimeout = setTimeout(() => {
        if (current() && !state.aaiReady) {
            cleanupAudio();
            showVoiceRetry('Voice connection timed out. Tap to reconnect.');
        }
    }, 10000);
    state.voiceTimer = aaiTimeout;

    try {
    dbg('connectToAssemblyAI() START');

    // 1. Get token
    let token;
    try {
        const tokenUrl = `${CONFIG.API_URL}/api/token`;
        dbg('Fetching token from: ' + tokenUrl);
        const tokenResp = await fetch(tokenUrl, { signal: state.audioAbort?.signal });
        if (!current()) return;
        dbg('Token response status: ' + tokenResp.status);
        if (!tokenResp.ok) {
            throw new Error(`Token HTTP ${tokenResp.status}`);
        }
        const data = await tokenResp.json();
        if (!current()) return;
        token = data.token;
        if (!token) {
            dbg('Token response did not include a token');
            throw new Error('No token in response');
        }
        dbg('Token received ✓ (length=' + token.length + ')');
    } catch (e) {
        if (!current()) return;
        state.voiceConnecting = false;
        dbg('TOKEN FETCH FAILED: ' + e.message);
        throw new Error('Token fetch failed: ' + e.message);
    }

    // 2. Reuse the audio primeAudio() already created + activated from the
    // Start button's user gesture. Creating it here instead (async, off any
    // gesture) is exactly what left captureCtx/playbackCtx stuck "suspended"
    // forever before this existed.
    if (!state.captureCtx || !state.playbackCtx || !state.mic) {
        state.voiceConnecting = false;
        throw new Error('Audio was not primed — tap Start first');
    }
    const stream = state.mic;
    dbg('Reusing primed audio: capture=' + state.captureCtx.state + ' playback=' + state.playbackCtx.state);

    dbg('Setting up capture worklet...');
    const source = captureCtx.createMediaStreamSource(stream);
    state.captureSource = source;
    const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture');
    if (!current()) { capture.disconnect(); source.disconnect(); return; }
    state.captureNode = capture;
    source.connect(capture);
    // NOTE: do NOT connect capture to destination — it only posts PCM via port.onmessage

    dbg('Setting up playback worklet...');
    const playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback');
    if (!current()) { playback.disconnect(); return; }
    state.playback = playback;
    playback.connect(playbackCtx.destination);

    // 3. Connect to AssemblyAI
    const aaiUrl = `${CONFIG.VOICE_AGENT_URL}?token=${token}`;
    dbg('Connecting AAI WebSocket to: ' + CONFIG.VOICE_AGENT_URL + '?token=***');
    const ws = new WebSocket(aaiUrl);
    state.aaiWs = ws;
    const ownsSocket = () => current() && state.aaiWs === ws;

    capture.port.onmessage = ({ data }) => {
        if (!ownsSocket()) return;
        if (!state.aaiReady || state.aaiWs?.readyState !== 1 || state.micMuted) return;
        const bytes = new Uint8Array(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        state.aaiWs.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }));
    };

    ws.onopen = () => {
        if (!ownsSocket()) return;
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
        state.micMuted = scanPending || state.fsmState === 'uploading_documents';

        // The business's configured welcome_message — previously stored in
        // D1 but never actually sent anywhere; every visitor heard the same
        // hardcoded "Hello! Welcome to X..." regardless of what was set up.
        const greetingBase = state.welcomeMessage || `Welcome to ${state.businessName || 'our office'}!`;
        // output.voice is immutable once the session is live (AssemblyAI
        // docs), so this initial connect is the only place it can be set —
        // voiceId must be one of AssemblyAI's own catalog IDs (validated
        // server-side in worker.js), never the free-text voicePersona.
        const output = { voice: state.voiceId || 'anna' };

        const sessionUpdate = {
            type: 'session.update',
            session: scanPending
                ? {
                    system_prompt: buildGreetingOnlyPrompt(),
                    greeting: `${greetingBase} Please upload your ID document using the button on screen.`,
                    output,
                    input: { turn_detection: TURN_DETECTION, keyterms: buildKeyterms() },
                    tools: [],
                }
                : {
                    system_prompt: buildInterviewPrompt(),
                    greeting: `${greetingBase} Let's get you checked in.`,
                    output,
                    input: { turn_detection: TURN_DETECTION, keyterms: buildKeyterms() },
                    tools: buildInterviewTools(),
                },
        };
        if (state.pendingInterviewHandoff) delete sessionUpdate.session.greeting;
        dbg('Sending session.update (scanPending=' + scanPending + ')');
        state.aaiWs.send(JSON.stringify(sessionUpdate));
        dbg('session.update sent ✓ — waiting for session.ready');
    };

    ws.onmessage = ({ data }) => {
        if (!ownsSocket()) return;
        try {
            handleAAILogic(JSON.parse(data));
        } catch (err) {
            dbg('ERROR parsing AAI message: ' + err.message);
        }
    };

    ws.onerror = (err) => {
        if (!ownsSocket()) return;
        clearTimeout(aaiTimeout);
        dbg('AAI WebSocket ERROR');
        cleanupAudio();
        showVoiceRetry('Voice connection error. Tap to reconnect.');
    };

    ws.onclose = (ev) => {
        clearTimeout(aaiTimeout);
        if (!ownsSocket()) return;
        cleanupAudio();
        showVoiceRetry('Voice disconnected. Tap to reconnect.');
    };
    } catch (error) {
        // An abandoned setup may reject after a new visitor has started.
        if (current()) {
            cleanupAudio();
            showVoiceRetry('Voice setup failed: ' + error.message);
        }
    }
}


function handleAAILogic(msg) {
    state.lastAAIEvent = msg.type;
    dbg('AAI ← ' + msg.type);
    switch (msg.type) {
        case 'session.ready':
            dbg('session.ready — VOICE IS LIVE ✓');
            clearTimeout(state.voiceTimer);
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

        case 'reply.started': state.replyNumber++; state.replyDoneSinceLastFlush = false; updateStatus('Speaking...'); break;
        case 'reply.done':
            state.replyDoneSinceLastFlush = true;
            updateStatus('Listening...');
            if (msg.status === 'interrupted') {
                // Per AssemblyAI docs: discard any tool.result queued during a reply
                // that got cut short — the turn it belonged to no longer exists.
                state.playback?.port.postMessage('stop');
                for (const entry of state.toolCalls.values()) if (entry.reply === state.replyNumber) entry.cancelled = true;
                state.pendingToolResults = state.pendingToolResults.filter(entry => !entry.cancelled);
            } else {
                flushPendingToolResults();
            }
            break;
        case 'transcript.user': addMessage('user', msg.text); break;
        case 'transcript.agent': addMessage('agent', msg.text); break;
        case 'session.ended': state.aaiReady = false; break;
        case 'session.error': cleanupAudio(); showVoiceRetry('Voice error. Tap to reconnect.'); break;

        case 'tool.call':
            queueToolResult(msg);
            break;
        default:
            dbg('Unhandled AAI message: ' + msg.type);
            break;
    }
}

// ── Tool calls ─────────────────────────────────────────────────────────────
// Per AssemblyAI docs, tool.result must be sent only once reply.done is the
// latest event received (never immediately on tool.call) — so we queue here
// and flush from the reply.done handler in handleAAILogic.

function queueToolResult(msg) {
    if (!msg.call_id || state.toolCalls.has(msg.call_id)) return;
    const generation = state.voiceGeneration;
    const entry = { call_id: msg.call_id, generation, reply: state.replyNumber, cancelled: false, sent: false };
    state.toolCalls.set(msg.call_id, entry);
    let type, payload;
    const args = msg.arguments || {};
    if (msg.name === 'submit_answer') { type = 'user_transcript'; payload = { field: args.field, text: args.answer }; }
    else if (msg.name === 'correct_ocr_field') { type = 'ocr_correction'; payload = { field: args.field, value: args.value }; }
    else if (msg.name === 'confirm_registration') { type = 'confirm'; payload = {}; }
    const operation = type ? requestOperation(type, payload) : Promise.reject(new Error('Unknown tool'));
    entry.promise = operation.then(() => {
        if (generation !== state.voiceGeneration || entry.cancelled) return;
        if (type === 'ocr_correction') {
            state.ocrData = { ...(state.ocrData || {}), [args.field]: args.value };
            displayOCRResult(state.ocrData);
        }
        entry.result = JSON.stringify({ success: true });
    }, error => {
        entry.result = JSON.stringify({ success: false, error: error.message });
        entry.is_error = true;
    }).then(() => {
        if (generation !== state.voiceGeneration || entry.cancelled || !entry.result) return;
        state.pendingToolResults.push(entry);
        flushPendingToolResults();
    });
    return entry.promise;
}

function flushPendingToolResults() {
    // https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference#toolresult
    // An ACK can arrive after reply.done: still wait if another AAI event intervened.
    if (!state.replyDoneSinceLastFlush || state.aaiWs?.readyState !== 1) return;
    const pending = state.pendingToolResults;
    state.pendingToolResults = [];
    let sent = false;
    for (const entry of pending) {
        if (entry.generation !== state.voiceGeneration || entry.cancelled || entry.sent) continue;
        try {
            state.aaiWs.send(JSON.stringify({ type: 'tool.result', call_id: entry.call_id,
                result: entry.result, is_error: !!entry.is_error }));
            entry.sent = true;
            sent = true;
        } catch (_) { state.pendingToolResults.push(entry); }
    }
    if (sent) state.replyDoneSinceLastFlush = false;
}

// ── Voice prompts ────────────────────────────────────────────────────────
// Two prompts, one per phase of the conversation. `greeting` is immutable
// once a session is live (AssemblyAI docs), so the scan→interview handoff
// (sendInterviewHandoff) only ever touches system_prompt/tools/input
// (turn_detection) — never greeting or output.

// Phase 1 (only used while requires_id_scan is true and OCR hasn't landed
// yet): announcement-only, no tools, agent stays quiet after the greeting
// instead of launching into the questionnaire before the visitor has scanned.
// Free-text tone/style guidance configured per-business (e.g. "warm and
// reassuring, speaks slowly") — this is what voicePersona is actually for.
// It cannot select the TTS voice itself (that's voiceId, a validated
// AssemblyAI catalog ID set once at connect via output.voice).
function personaLine() {
    return state.voicePersona ? `\nPERSONALITY: ${state.voicePersona}\n` : '';
}

// AssemblyAI docs: session.input.keyterms biases the ASR toward domain
// vocabulary it would otherwise mishear (business name, field names like
// "date_of_birth"). Capped at 100 terms / 50 chars each per the API.
function buildKeyterms() {
    const terms = [];
    if (state.businessName) terms.push(state.businessName);
    for (const q of state.questions || []) {
        if (!q.field) continue;
        const readable = String(q.field).replace(/_/g, ' ').trim();
        if (readable && !terms.includes(readable)) terms.push(readable);
    }
    return terms.filter(t => t.length > 0 && t.length <= 50).slice(0, 100);
}

function buildGreetingOnlyPrompt() {
    return `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.
${personaLine()}
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
    const ocrSection = ocrName && !state.resumed
        ? `\nID SCAN RESULT:\n- Name: ${ocrName}${ocrFields ? '\n- ' + ocrFields : ''}\n\nSTEP 1 (do this first, before any numbered question): thank the visitor by name — say something like "Thank you, Mr./Ms. ${ocrName}!" — then read back the data above and ask "Is this correct?" Wait for a yes or no. Do NOT call submit_answer for this — it is not one of the numbered questions. If they say ANY field is wrong, ask them to state the correct value, then immediately call correct_ocr_field with that field and the corrected value — do this for every field they correct, before moving on to STEP 2.`
        : '';
    const questionsList = (state.questions || []).map((q, i) => `${i + 1}. "${q.text}" (field: ${q.field})`).join('\n');

    return `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.
${personaLine()}${ocrSection}
${state.resumed ? `RESTORED SESSION: current phase ${state.fsmState}; next question number ${state.currentQuestionIndex + 1}. Already saved answers: ${JSON.stringify(state.answers)}. Do not repeat answered questions or the ID check. Continue at the first unanswered question; if confirming, read the existing summary and ask for confirmation. If uploading_documents, wait for the screen controls.` : ''}

STEP 2 — QUESTIONS (ask ONE AT A TIME, in order, only after the ID scan is confirmed):
${questionsList}

FLOW:
${ocrSection ? '1. Do STEP 1 (confirm ID scan) first\n2. Then STEP 2' : '1. Start with STEP 2'}
- For each question: ask it, wait for the answer, call submit_answer with that question's field and their answer, and wait for a successful tool result before acknowledging it or moving on. If a tool fails, explain that the result is unconfirmed and offer a retry; never claim it was saved.
- After all questions, summarize everything and ask "Is everything correct?" Once the visitor says yes, call confirm_registration — this is the ONLY way the check-in actually finishes, so never skip it. If they say a numbered answer is wrong instead — even after hearing the summary — call submit_answer again with that question's field and the corrected value (this replaces the old answer, it does not add a new one), then summarize again and ask once more. Use correct_ocr_field only for ID scan data, never for a numbered question.

RULES:
- Speak in the visitor's language
- Keep sentences short — this is voice
- Never generate your own questions
- submit_answer ALWAYS needs the field of the question being answered or corrected — never assume the server can infer which one from order alone
- submit_answer is ONLY for the numbered questions in STEP 2 — never for the ID scan confirmation
- correct_ocr_field is ONLY for fixing wrong ID scan data — call it as soon as the visitor states a correction, never skip this step
- confirm_registration is ONLY called once, after the visitor confirms the final summary is correct — never before`;
}

function buildInterviewTools() {
    return [
        {
            type: 'function',
            name: 'submit_answer',
            description: 'Submit the visitor\'s answer for a numbered question, identified by its field key. Also use this to CORRECT an earlier answer if the visitor asks to change one — even after the summary — by calling it again with that question\'s field and the new value. Do not use this for the ID scan confirmation step.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', description: 'The field key of the question being answered or corrected, exactly as given in the numbered list (e.g. "date_of_birth")' },
                    answer: { type: 'string' },
                },
                required: ['field', 'answer'],
            },
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
        {
            type: 'function',
            name: 'confirm_registration',
            description: 'Call this once, after reading back the full summary and the visitor confirms everything is correct. This actually finalizes the check-in — without it, the registration is never saved.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    ];
}

// One-shot instructions for reply.create — see sendInterviewHandoff for why
// this is needed at all (session.update alone doesn't make the agent speak).
function buildInterviewHandoffInstructions() {
    if (state.resumed) return state.fsmState === 'confirming'
        ? 'Read back the saved summary, then ask if it is correct. Do not restart the questions.'
        : 'Continue from the next unanswered question in the restored session. Do not repeat the ID check or any saved answer.';
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
    if (state.interviewHandoffGeneration === state.voiceGeneration) return;
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
    if (state.aaiWs?.readyState !== 1 || state.interviewHandoffGeneration === state.voiceGeneration) return;
    state.interviewHandoffGeneration = state.voiceGeneration;
    dbg('Sending interview handoff via session.update');
    state.micMuted = false; // scan is confirmed — let the mic through again
    state.aaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
            system_prompt: buildInterviewPrompt(),
            tools: buildInterviewTools(),
            // Real conversation starts here (mic just unmuted) — this is the
            // point where noise-robust turn detection actually matters most.
            input: { turn_detection: TURN_DETECTION, keyterms: buildKeyterms() },
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

// Narrates the optional documents step — the actual advance is 100%
// UI-driven (upload button / continue button), never a tool call, so
// there's no risk of the agent "forgetting" to move things along the way
// confirm_registration turned out to need fixing for the summary step.
function announceDocumentsStep(prompt) {
    if (state.aaiWs?.readyState !== 1) return;
    dbg('Announcing documents step via reply.create');
    state.aaiWs.send(JSON.stringify({
        type: 'reply.create',
        instructions: `Tell the visitor: "${prompt}" Then stay quiet — this step doesn't need you until they finish it.`,
    }));
}

async function uploadDocuments(fileList) {
    if (!state.sessionId || !fileList || !fileList.length) return;
    let uploaded = 0;
    for (const file of fileList) {
        try {
            const putResp = await fetch(`${CONFIG.API_URL}/api/ws/${state.sessionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
            });
            if (!putResp.ok) throw new Error('HTTP ' + putResp.status);
            uploaded++;
            dbg('Document uploaded: ' + file.name);
        } catch (err) {
            dbg('Document upload failed (' + file.name + '): ' + err.message);
            updateStatus('Failed to upload ' + file.name);
        }
    }
    state.documentsUploadedCount += uploaded;
    if (elements.documentsUploadedCount) {
        elements.documentsUploadedCount.textContent = `${state.documentsUploadedCount} file(s) uploaded`;
        elements.documentsUploadedCount.classList.toggle('hidden', state.documentsUploadedCount === 0);
    }
    if (elements.btnDocumentsContinue && state.documentsUploadedCount > 0) {
        elements.btnDocumentsContinue.textContent = '➡️ Continue';
    }
}

async function finishDocumentsStep() {
    const sessionId = state.sessionId, generation = state.voiceGeneration;
    if (!state.documentsOperationId) state.documentsOperationId = crypto.randomUUID();
    if (elements.btnDocumentsContinue) elements.btnDocumentsContinue.disabled = true;
    try {
        await requestOperation('documents_done', {}, state.documentsOperationId);
        if (sessionId !== state.sessionId || generation !== state.voiceGeneration || state.checkinDone) return;
        state.micMuted = false;
    } catch (err) {
        if (sessionId !== state.sessionId || generation !== state.voiceGeneration || state.checkinDone) return;
        if (err.confirmedFailure && !err.retryable) state.documentsOperationId = null;
        if (elements.btnDocumentsContinue) elements.btnDocumentsContinue.disabled = false;
        updateStatus(err.message);
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
        // Built with textContent, not innerHTML — v comes from the vision
        // model's OCR read of the document (and can be overwritten by
        // correct_ocr_field from whatever the visitor says), so it must
        // never be treated as markup.
        const label = document.createElement('span'); label.className = 'field-label'; label.textContent = labels[k] || k;
        const value = document.createElement('span'); value.className = 'field-value'; value.textContent = v;
        r.appendChild(label); r.appendChild(value);
        c.appendChild(r);
    }
    elements.ocrResult?.classList.remove('hidden');
    updateStatus('Document scanned');
}

function showSummary(answers, ocr) {
    // The summary and its confirmation button live on the voice screen,
    // including when arriving from the optional documents step.
    showStep('voice');
    state.fsmState = 'confirming';
    state.answers = answers || state.answers;
    state.ocrData = ocr || state.ocrData;
    if (elements.btnConfirmSummary) elements.btnConfirmSummary.disabled = false;
    updateStatus('Review your check-in');
    let s = '📋 Summary:\n';
    if (answers) for (const [q, a] of Object.entries(answers)) s += `• ${q}: ${a}\n`;
    if (ocr) { s += '\n📄 Document:\n'; for (const [k, v] of Object.entries(ocr)) if (v) s += `• ${k}: ${v}\n`; }
    addMessage('agent', s);
    // Confirming should normally happen by voice (confirm_registration), but
    // never make it the ONLY way to finish — an agent that says its goodbyes
    // without actually calling the tool, or a voice connection that dropped
    // right in this window, would otherwise leave the visitor stuck here
    // with no way out. This button sends the same {type:'confirm'} directly.
    elements.summaryActions?.classList.remove('hidden');
}

function hideSummaryActions() {
    elements.summaryActions?.classList.add('hidden');
}

function showDone(registrationId) {
    state.fsmState = 'done';
    clearTimeout(doReconnectTimer);
    state.checkinDone = true; // stop the DO WS reconnect loop from firing after a normal finish
    // This visitor's session is finished — a later reload or the next
    // visitor on this device must never resume into a completed check-in.
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (_) {}
    hideSummaryActions();
    updateStatus('Check-in complete'); showStep('confirm');
    if (elements.confirmMessage) elements.confirmMessage.textContent = 'Your check-in is complete!';
    if (elements.confirmId) elements.confirmId.textContent = `Registration ID: ${registrationId}`;
    cleanupAudio();
}

function cleanupAudio() {
    stopCamera();
    state.audioAbort?.abort(); state.audioAbort = null;
    state.voiceGeneration++;
    state.aaiReady = false; state.voiceConnecting = false;
    clearTimeout(state.voiceTimer); clearTimeout(state.ocrTimeout);
    state.lastAAIEvent = null; state.replyNumber = 0;
    state.pendingToolResults = []; state.toolCalls.clear();
    rejectPendingOperations('Session ended before server confirmation');
    const ws = state.aaiWs; state.aaiWs = null;
    if (ws) {
        if (ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'session.end' })); } catch (_) {}
            setTimeout(() => { try { ws.close(); } catch (_) {} }, 2000);
        } else { try { ws.close(); } catch (_) {} }
    }
    state.captureNode && (state.captureNode.port.onmessage = null);
    try { state.captureNode?.disconnect(); state.captureSource?.disconnect(); } catch (_) {}
    state.captureNode = state.captureSource = null;
    state.mic?.getTracks().forEach(track => track.stop()); state.mic = null;
    state.playback?.port.postMessage('stop'); state.playback = null;
    for (const ctx of [state.captureCtx, state.playbackCtx]) {
        if (ctx) { try { Promise.resolve(ctx.close()).catch(() => {}); } catch (_) {} }
    }
    state.captureCtx = state.playbackCtx = null;
}

async function confirmSummary() {
    const sessionId = state.sessionId, generation = state.voiceGeneration;
    if (!state.manualConfirmOperationId) state.manualConfirmOperationId = crypto.randomUUID();
    if (elements.btnConfirmSummary) elements.btnConfirmSummary.disabled = true;
    try { await requestOperation('confirm', {}, state.manualConfirmOperationId); }
    catch (err) {
        if (sessionId !== state.sessionId || generation !== state.voiceGeneration || state.checkinDone) return;
        if (err.confirmedFailure && !err.retryable) state.manualConfirmOperationId = null;
        if (elements.btnConfirmSummary) elements.btnConfirmSummary.disabled = false;
        updateStatus(err.message);
    }
}

function initEventListeners() {
    // Take a photo using getUserMedia camera preview, or fall back to file picker.
    // Both feed the same upload path.
    elements.btnTakePhoto?.addEventListener('click', startCamera);
    elements.btnCapture?.addEventListener('click', capturePhoto);
    elements.btnCancelCamera?.addEventListener('click', stopCamera);
    $('file-upload')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) uploadAndProcess(file, file.type);
        e.target.value = '';
    });
    $('documents-upload')?.addEventListener('change', (e) => {
        uploadDocuments(e.target.files);
        e.target.value = '';
    });
    elements.btnDocumentsContinue?.addEventListener('click', () => {
        elements.btnDocumentsContinue.disabled = true;
        finishDocumentsStep();
    });
    elements.btnConfirmSummary?.addEventListener('click', confirmSummary);

    elements.btnNewVisitor?.addEventListener('click', () => {
        state.answers = {}; state.ocrData = null;
        cleanupAudio();
        rejectPendingOperations('New visitor');
        clearTimeout(doReconnectTimer); doReconnectAttempts = 0;
        state.sessionId = null; state.resumed = false; state.fsmState = 'idle';
        state.manualConfirmOperationId = state.documentsOperationId = null;
        state.currentQuestionIndex = 0;
        try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch (_) {}
        // Without this reset, a new visitor whose business also requires an
        // ID scan would skip straight to the interview prompt on connect,
        // since scanCompleted/requiresIdScan would still carry over true
        // from the previous visitor's finished session.
        state.scanCompleted = false; state.pendingInterviewHandoff = false; state.requiresIdScan = false;
        state.documentsUploadedCount = 0;
        // Confirmed bug (external review, 2026-09): this was never reset, so
        // the SECOND visitor on the same device inherited the first one's
        // "done" flag — if their DO WebSocket ever dropped mid-interview,
        // the reconnect guard saw checkinDone=true (stale) and silently gave
        // up instead of reconnecting.
        state.checkinDone = false;
        if (elements.btnDocumentsContinue) { elements.btnDocumentsContinue.textContent = '➡️ Continue without uploading'; elements.btnDocumentsContinue.disabled = false; }
        if (elements.documentsUploadedCount) elements.documentsUploadedCount.classList.add('hidden');
        if (elements.btnConfirmSummary) elements.btnConfirmSummary.disabled = false;
        hideSummaryActions();
        if (elements.transcriptMessages) elements.transcriptMessages.innerHTML = '';
        const old = state.doWs; state.doWs = null; old?.close();
        // cleanupAudio() just tore down the AudioContexts/mic stream — the
        // NEXT visitor needs their own real tap to reactivate audio, same
        // reason the very first visitor needs step-start. Auto-reconnecting
        // here would hit the exact "stuck suspended" bug this screen fixes.
        elements.stepStart?.classList.remove('hidden');
        if (elements.btnStart) {
            elements.btnStart.disabled = false;
            elements.btnStart.textContent = '🎤 Tap to Start';
            // The Start listener is persistent; startPending prevents double activation.
        }
    });
    window.addEventListener('beforeunload', () => { cleanupAudio(); state.doWs?.close(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
// Explicit module exports let the dependency-free regression suite exercise the
// same functions as the browser; no alternate test implementation or auto-start.
export const __testing = { state, elements, startCheckin, primeAudio, cleanupAudio,
    handleDOMessage, handleAAILogic, queueToolResult, connectToDO, reconnectToDO,
    proceedToInterview, sendInterviewHandoff, showDone, initEventListeners,
    requestOperation, flushPendingToolResults, buildInterviewPrompt, finishDocumentsStep,
    confirmSummary, SESSION_STORAGE_KEY, SESSION_TTL_MS, stopCamera, startCamera, capturePhoto };

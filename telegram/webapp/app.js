/**
 * Virtualobby — Dual-WebSocket WebApp
 *
 * Two simultaneous connections:
 *   WS1: Durable Object (state management, questions, OCR results)
 *   WS2: AssemblyAI Voice Agent (voice/audio capture + playback)
 *
 * Flow: connect DO → camera/file upload → OCR → voice personalized → questions → done
 */

const CONFIG = {
    API_URL: 'https://virtualobby-api.alejdro.workers.dev',
    VOICE_AGENT_URL: 'wss://agents.assemblyai.com/v1/ws',
    tgApp: window.Telegram?.WebApp || null,
};

const WIRE_RATE = 24_000;

const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() { super(); this._ratio = sampleRate / ${WIRE_RATE}; this._pos = 0; this._prev = 0; this._src = null; this._out = null; }
    _toPcm(samples, len) { const pcm = new Int16Array(len); for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, samples[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return pcm; }
    process(inputs) {
      const ch = inputs[0]?.[0]; if (!ch) return true;
      if (this._ratio === 1) { const pcm = this._toPcm(ch, ch.length); this.port.postMessage(pcm.buffer, [pcm.buffer]); return true; }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) { this._src = new Float32Array(n + 1); this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2); }
      const src = this._src; const out = this._out; src[0] = this._prev; src.set(ch, 1);
      let outLen = 0; let pos = this._pos;
      while (pos < n) { const i = Math.floor(pos); const frac = pos - i; out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac; pos += this._ratio; }
      this._pos = pos - n; this._prev = ch[n - 1];
      if (outLen) { const pcm = this._toPcm(out, outLen); this.port.postMessage(pcm.buffer, [pcm.buffer]); }
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super(); this._ring = new Float32Array(sampleRate * 30); this._writePos = 0; this._readPos = 0;
      this._available = 0; this._step = ${WIRE_RATE} / sampleRate; this._rsPos = 0; this._rsPrev = 0; this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') { this._writePos = this._readPos = this._available = 0; this._rsPos = this._rsPrev = 0; return; }
        const int16 = new Int16Array(e.data); if (!int16.length) return;
        if (this._drained) { this._rsPrev = 0; this._rsPos = 0; this._drained = false; }
        if (this._step === 1) { for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768); return; }
        const n = int16.length; let pos = this._rsPos;
        while (pos < n) { const i = Math.floor(pos); const frac = pos - i; const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768; const b = int16[i] / 32768; this._push(a + (b - a) * frac); pos += this._step; }
        this._rsPos = pos - n; this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) { if (this._available < this._ring.length) { this._ring[this._writePos] = v; this._writePos = (this._writePos + 1) % this._ring.length; this._available++; } }
    process(inputs, outputs) {
      const output = outputs[0]; const out = output[0]; const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) { if (this._available > 0) { out[i] = this._ring[this._readPos]; this._readPos = (this._readPos + 1) % cap; this._available--; } else { out[i] = 0; this._drained = true; } }
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out); return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`;

// ── State ──────────────────────────────────────────────────────────────────

const state = {
    businessId: null,
    businessName: '',
    doWs: null,
    aaiWs: null,
    captureCtx: null,
    playbackCtx: null,
    playback: null,
    mic: null,
    aaiReady: false,
    currentFsmState: 'idle',
    questions: [],
    answers: {},
    ocrData: null,
    requiresIdScan: false,
    cameraFacing: 'environment',
    mediaStream: null,
    cameraAvailable: false,
};

const $ = (id) => document.getElementById(id);

const elements = {
    stepScan: $('step-scan'),
    stepVoice: $('step-voice'),
    stepConfirm: $('step-confirm'),
    cameraContainer: $('camera-container'),
    cameraPreview: $('camera-preview'),
    cameraCanvas: $('camera-canvas'),
    cameraControls: $('camera-controls'),
    ocrResult: $('ocr-result'),
    ocrFields: $('ocr-fields'),
    ocrLoading: $('ocr-loading'),
    scanActions: $('scan-actions'),
    transcriptMessages: $('transcript-messages'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    btnNewVisitor: $('btn-new-visitor'),
    confirmMessage: $('confirm-message'),
    confirmId: $('confirm-id'),
};

// ── Helpers ────────────────────────────────────────────────────────────────

function updateStatus(text) {
    if (elements.statusText) elements.statusText.textContent = text;
    if (elements.statusDot) {
        elements.statusDot.className = 'status-dot ' +
            (text.includes('Listening') ? 'listening' :
             text.includes('Speaking') ? 'speaking' : '');
    }
}

function showStep(step) {
    const steps = { scan: elements.stepScan, voice: elements.stepVoice, confirm: elements.stepConfirm };
    for (const [key, el] of Object.entries(steps)) {
        if (el) el.classList.toggle('hidden', key !== step);
    }
}

function addMessage(who, text) {
    if (!elements.transcriptMessages) return;
    const div = document.createElement('div');
    div.className = `message ${who}`;
    div.textContent = text;
    elements.transcriptMessages.appendChild(div);
    elements.transcriptMessages.scrollTop = elements.transcriptMessages.scrollHeight;
}

// ── Telegram Init ──────────────────────────────────────────────────────────

function initTelegram() {
    const tg = CONFIG.tgApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    const startParam = (tg.initDataUnsafe || {}).start_param || '';
    if (startParam) state.businessId = startParam;
}

// ── DO WebSocket ───────────────────────────────────────────────────────────

async function connectToDO() {
    const wsUrl = `${CONFIG.API_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/api/ws/${crypto.randomUUID()}`;
    state.doWs = new WebSocket(wsUrl);

    state.doWs.onopen = () => {
        state.doWs.send(JSON.stringify({
            type: 'start',
            business_id: state.businessId || 'clinic-main',
        }));
    };

    state.doWs.onmessage = (event) => handleDOMessage(JSON.parse(event.data));
    state.doWs.onerror = (err) => console.error('DO WebSocket error:', err);
    state.doWs.onclose = () => console.log('DO disconnected');
}

// ── DO Message Handler ─────────────────────────────────────────────────────

function handleDOMessage(msg) {
    console.log('DO ←', msg.type, msg);

    switch (msg.type) {
        case 'welcome':
            state.businessName = msg.business_name || '';
            state.requiresIdScan = msg.requires_id_scan;
            state.questions = msg.questions || [];
            // Update header with business name
            const headerTitle = document.getElementById('header-title');
            if (headerTitle) headerTitle.textContent = `Welcome to ${state.businessName}`;
            updateStatus(msg.text || 'Connected');
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
            console.log('Questions ready, OCR data:', state.ocrData);
            state.questions = msg.questions || state.questions;
            state.ocrData = msg.ocr_data || state.ocrData;
            state.businessName = msg.business_name || state.businessName;
            stopCamera();
            updateStatus('Connecting voice...');
            // Brief delay so user sees OCR result before switching to voice
            setTimeout(() => {
                showStep('voice');
                connectToAssemblyAI().catch(err => {
                    console.error('Failed to connect voice:', err);
                    updateStatus('Voice connection failed');
                });
            }, 1500);
            break;

        case 'state':
            state.currentFsmState = msg.state;
            updateStatus(`Question ${msg.index + 1}/${msg.total}: ${msg.question}`);
            break;

        case 'summary':
            showSummary(msg.answers, msg.ocr);
            break;

        case 'checkin_complete':
            showDone(msg.registration_id);
            break;

        case 'error':
            updateStatus('Error: ' + msg.message);
            break;
    }
}

// ── Camera ─────────────────────────────────────────────────────────────────

async function startCamera() {
    try {
        if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(t => t.stop());
        }
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: state.cameraFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        elements.cameraPreview.srcObject = state.mediaStream;
        elements.cameraContainer?.classList.remove('hidden');
        elements.cameraControls?.classList.remove('hidden');
        state.cameraAvailable = true;
    } catch (err) {
        console.log('Camera not available, using file upload fallback:', err.message);
        elements.cameraContainer?.classList.add('hidden');
        elements.cameraControls?.classList.add('hidden');
        state.cameraAvailable = false;
    }
}

function stopCamera() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = null;
    }
}

// ── Capture from live camera ───────────────────────────────────────────────

async function captureFromCamera() {
    const video = elements.cameraPreview;
    const canvas = elements.cameraCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8)
    );

    await uploadAndProcess(blob, 'image/jpeg');
}

// ── Upload file (from camera capture or file input) ────────────────────────

async function uploadAndProcess(blobOrFile, contentType) {
    elements.ocrLoading?.classList.remove('hidden');

    try {
        const urlResp = await fetch(`${CONFIG.API_URL}/api/upload-url`);
        if (!urlResp.ok) throw new Error('Failed to get upload URL');
        const { upload_url, r2_key } = await urlResp.json();

        const putResp = await fetch(upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': contentType || 'image/jpeg' },
            body: blobOrFile,
        });
        if (!putResp.ok) throw new Error('Upload failed');

        if (state.doWs?.readyState === 1) {
            state.doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key }));
        }

        stopCamera();
        updateStatus('Document uploaded, processing...');

    } catch (err) {
        console.error('Upload error:', err);
        updateStatus('Upload failed, please try again');
    } finally {
        elements.ocrLoading?.classList.add('hidden');
    }
}

// ── AssemblyAI Voice Agent ─────────────────────────────────────────────────

async function connectToAssemblyAI() {
    console.log('connectToAssemblyAI called');
    try {
        console.log('Fetching token...');
        const tokenResp = await fetch(`${CONFIG.API_URL}/api/token`);
        if (!tokenResp.ok) throw new Error('Failed to get token');
        const { token } = await tokenResp.json();
        console.log('Token received, setting up audio...');

        state.captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
        state.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
        console.log('AudioContext created, requesting microphone...');

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        state.mic = stream;
        console.log('Microphone access granted');

        const source = state.captureCtx.createMediaStreamSource(stream);
        const capture = await addWorklet(state.captureCtx, CAPTURE_WORKLET, 'capture');
        source.connect(capture);
        capture.connect(state.captureCtx.destination);

        state.playback = await addWorklet(state.playbackCtx, PLAYBACK_WORKLET, 'playback');
        state.playback.connect(state.playbackCtx.destination);

        state.aaiWs = new WebSocket(`${CONFIG.VOICE_AGENT_URL}?token=${token}`);

        capture.port.onmessage = ({ data }) => {
            if (!state.aaiReady || state.aaiWs?.readyState !== 1) return;
            const bytes = new Uint8Array(data);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            state.aaiWs.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }));
        };

        state.aaiWs.onopen = () => {
            const ocrName = state.ocrData?.name || '';
            const ocrFields = state.ocrData
                ? Object.entries(state.ocrData).filter(([k, v]) => v && k !== 'name').map(([k, v]) => `${k}: ${v}`).join(', ')
                : '';

            const ocrSection = ocrName
                ? `\nOCR DATA (from ID scan):\n- Visitor name: ${ocrName}${ocrFields ? '\n- Other fields: ' + ocrFields : ''}\n\nStart by greeting the visitor by name and reading back the OCR data. Ask "Is this correct?" and wait for confirmation. Then proceed with the questions.`
                : '';

            const questionsList = (state.questions || [])
                .map((q, i) => `${i + 1}. "${q.text}" (field: ${q.field})`)
                .join('\n');

            const systemPrompt = `You are a friendly virtual reception assistant at ${state.businessName || 'this office'}.

FLOW:
1. Greet the visitor warmly: "Welcome to ${state.businessName || 'our office'}! I'm your virtual assistant and I'll help you with check-in."
${ocrSection ? '2. Read back the OCR data from their ID and ask "Is this correct?"\n3. Wait for confirmation, then say "Great" or "Let me update that" if they correct something' : '2. Ask each question below ONE AT A TIME'}
4. Ask each question below ONE AT A TIME, wait for answer, confirm briefly ("Got it", "Understood")
5. After the visitor answers and you have confirmed their response, call the submit_answer tool with their answer
6. Then move to the next question
7. After all questions, summarize what you collected
8. Ask for final confirmation

QUESTIONS TO ASK (in this exact order):
${questionsList}

RULES:
- Speak in the visitor's language (detect from their first message)
- Keep sentences short — this is voice, not text
- Never generate your own questions — only ask the ones listed above
- After the visitor answers, confirm briefly then call submit_answer with the extracted answer before moving on
- Do NOT call submit_answer for partial speech, clarifications, or off-topic remarks — only when you have a confirmed answer to the current question
- If visitor asks something off-topic, redirect: "Let's continue with the check-in"`;

            state.aaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                    system_prompt: systemPrompt,
                    greeting: ocrName
                        ? `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today. I see from your ID that your name is ${ocrName}. Let me confirm your details.`
                        : `Hello! Welcome to ${state.businessName || 'our office'}. My name is Anna and I'll be your virtual reception assistant today. Let's get you checked in.`,
                    output: { type: 'audio', voice: 'anna' },
                    tools: [{
                        type: 'function',
                        name: 'submit_answer',
                        description: 'Submit the visitor answer for the current question. Call this after the visitor answers and you have confirmed their response.',
                        parameters: {
                            type: 'object',
                            properties: {
                                answer: { type: 'string', description: 'The visitor answer to the current question' },
                            },
                            required: ['answer'],
                        },
                    }],
                },
            }));
        };

        state.aaiWs.onmessage = ({ data }) => handleAAILogic(JSON.parse(data));
        state.aaiWs.onerror = (err) => console.error('AAI WebSocket error:', err);
        state.aaiWs.onclose = () => { console.log('AAI WebSocket closed'); state.aaiReady = false; };

    } catch (err) {
        console.error('AssemblyAI connection error:', err);
        addMessage('agent', 'Voice connection failed. You can still complete check-in visually.');
    }
}

// ── AAI Message Handler ────────────────────────────────────────────────────

function handleAAILogic(msg) {
    switch (msg.type) {
        case 'session.ready':
            state.aaiReady = true;
            updateStatus('Voice ready');
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

        case 'reply.started':
            updateStatus('Speaking...');
            break;

        case 'reply.done':
            updateStatus('Listening...');
            if (msg.status === 'interrupted') state.playback?.port.postMessage('stop');
            break;

        case 'transcript.user':
            addMessage('user', msg.text);
            break;

        case 'transcript.agent':
            addMessage('agent', msg.text);
            break;

        case 'session.ended':
            state.aaiReady = false;
            break;

        case 'session.error':
            updateStatus('Voice error: ' + msg.message);
            break;

        case 'tool.call':
            if (msg.name === 'submit_answer') {
                const answer = msg.arguments?.answer || '';
                if (state.doWs?.readyState === 1) {
                    state.doWs.send(JSON.stringify({ type: 'user_transcript', text: answer }));
                }
                if (state.aaiWs?.readyState === 1) {
                    state.aaiWs.send(JSON.stringify({
                        type: 'tool.result',
                        call_id: msg.call_id,
                        result: JSON.stringify({ success: true }),
                    }));
                }
            }
            break;
    }
}

// ── Audio worklet helper ───────────────────────────────────────────────────

async function addWorklet(ctx, code, name) {
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    return new AudioWorkletNode(ctx, name);
}

// ── OCR Result Display ─────────────────────────────────────────────────────

function displayOCRResult(fields) {
    const container = elements.ocrFields;
    if (!container) return;
    container.innerHTML = '';

    const labels = {
        name: 'Name', full_name: 'Name', id_number: 'ID Number',
        date_of_birth: 'Date of Birth', nationality: 'Nationality',
        expiry_date: 'Expiry Date', address: 'Address',
    };

    for (const [key, value] of Object.entries(fields || {})) {
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'field-row';
        row.innerHTML = `<span class="field-label">${labels[key] || key}</span><span class="field-value">${value}</span>`;
        container.appendChild(row);
    }

    elements.ocrResult?.classList.remove('hidden');
    updateStatus('Document scanned — processing...');
}

// ── Summary & Done ─────────────────────────────────────────────────────────

function showSummary(answers, ocr) {
    updateStatus('Review your check-in');
    let summary = '📋 Check-in Summary:\n';
    if (answers) for (const [q, a] of Object.entries(answers)) summary += `• ${q}: ${a}\n`;
    if (ocr) {
        summary += '\n📄 Document:\n';
        for (const [k, v] of Object.entries(ocr)) if (v) summary += `• ${k}: ${v}\n`;
    }
    addMessage('agent', summary);
}

function showDone(registrationId) {
    updateStatus('Check-in complete');
    showStep('confirm');
    if (elements.confirmMessage) elements.confirmMessage.textContent = 'Your check-in is complete!';
    if (elements.confirmId) elements.confirmId.textContent = `Registration ID: ${registrationId}`;
    cleanupAudio();
}

// ── Audio cleanup ──────────────────────────────────────────────────────────

function cleanupAudio() {
    state.aaiReady = false;
    if (state.aaiWs?.readyState === 1) {
        state.aaiWs.send(JSON.stringify({ type: 'session.end' }));
        setTimeout(() => state.aaiWs?.close(), 2000);
    }
    state.playback?.port.postMessage('stop');
    state.mic?.getTracks().forEach(t => t.stop());
    state.captureCtx?.close();
    state.playbackCtx?.close();
    state.captureCtx = state.playbackCtx = state.playback = state.mic = null;
}

// ── Event Listeners ────────────────────────────────────────────────────────

function initEventListeners() {
    // Camera switch
    $('btn-switch-camera')?.addEventListener('click', () => {
        state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
        startCamera();
    });

    // Camera capture
    $('btn-capture')?.addEventListener('click', captureFromCamera);

    // File upload — camera
    $('file-upload-camera')?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) uploadAndProcess(e.target.files[0], e.target.files[0].type);
    });

    // File upload — gallery
    $('file-upload-gallery')?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) uploadAndProcess(e.target.files[0], e.target.files[0].type);
    });

    // New visitor
    elements.btnNewVisitor?.addEventListener('click', () => {
        state.answers = {};
        state.ocrData = null;
        if (elements.transcriptMessages) elements.transcriptMessages.innerHTML = '';
        cleanupAudio();
        if (state.doWs) { state.doWs.close(); state.doWs = null; }
        connectToDO();
    });

    window.addEventListener('beforeunload', () => {
        cleanupAudio();
        state.doWs?.close();
    });
}

// ── Initialize ─────────────────────────────────────────────────────────────

async function init() {
    console.log('Virtualobby initializing...');
    initTelegram();
    if (!state.businessId) state.businessId = 'clinic-main';
    initEventListeners();
    updateStatus('Connecting...');
    await connectToDO();
    console.log('Virtualobby initialized, business_id:', state.businessId);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

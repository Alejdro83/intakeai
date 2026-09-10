/**
 * Virtualobby — Dual-WebSocket WebApp
 *
 * Two simultaneous connections:
 *   WS1: Durable Object (state management, questions, OCR results)
 *   WS2: AssemblyAI Voice Agent (voice/audio capture + playback)
 *
 * Flow: parse start_param → connect DO → fetch token → connect AAI →
 *       voice Q&A → camera/OCR → summary → done
 */

// ── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
    API_URL: 'https://virtualobby-api.alejdro.workers.dev',
    VOICE_AGENT_URL: 'wss://agents.assemblyai.com/v1/ws',
    tgApp: window.Telegram?.WebApp || null,
};

// ── Audio worklet code (from AssemblyAI JS starter) ────────────────────────

const WIRE_RATE = 24_000;

const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ratio = sampleRate / ${WIRE_RATE};
      this._pos = 0;
      this._prev = 0;
      this._src = null;
      this._out = null;
    }
    _toPcm(samples, len) {
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) {
        const pcm = this._toPcm(ch, ch.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
      }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) {
        this._src = new Float32Array(n + 1);
        this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
      }
      const src = this._src;
      const out = this._out;
      src[0] = this._prev;
      src.set(ch, 1);
      let outLen = 0;
      let pos = this._pos;
      while (pos < n) {
        const i = Math.floor(pos);
        const frac = pos - i;
        out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
        pos += this._ratio;
      }
      this._pos = pos - n;
      this._prev = ch[n - 1];
      if (outLen) {
        const pcm = this._toPcm(out, outLen);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30);
      this._writePos = 0;
      this._readPos = 0;
      this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate;
      this._rsPos = 0;
      this._rsPrev = 0;
      this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') {
          this._writePos = this._readPos = this._available = 0;
          this._rsPos = this._rsPrev = 0;
          return;
        }
        const int16 = new Int16Array(e.data);
        if (!int16.length) return;
        if (this._drained) {
          this._rsPrev = 0;
          this._rsPos = 0;
          this._drained = false;
        }
        if (this._step === 1) {
          for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
          return;
        }
        const n = int16.length;
        let pos = this._rsPos;
        while (pos < n) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
          const b = int16[i] / 32768;
          this._push(a + (b - a) * frac);
          pos += this._step;
        }
        this._rsPos = pos - n;
        this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) {
      if (this._available < this._ring.length) {
        this._ring[this._writePos] = v;
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._available++;
      }
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const out = output[0];
      const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) {
        if (this._available > 0) {
          out[i] = this._ring[this._readPos];
          this._readPos = (this._readPos + 1) % cap;
          this._available--;
        } else {
          out[i] = 0;
          this._drained = true;
        }
      }
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`;

// ── State ──────────────────────────────────────────────────────────────────

const state = {
    businessId: null,
    doWs: null,                // Durable Object WebSocket
    aaiWs: null,               // AssemblyAI Voice Agent WebSocket
    captureCtx: null,          // AudioContext for mic capture
    playbackCtx: null,         // AudioContext for playback
    playback: null,            // PlaybackWorkletNode
    mic: null,                 // MediaStream
    aaiReady: false,           // AssemblyAI session.ready received
    currentFsmState: 'idle',
    currentQuestion: null,
    answers: {},
    ocrData: null,
    cameraFacing: 'environment',
    mediaStream: null,         // camera stream (separate from mic)
};

// ── DOM Elements ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elements = {
    stepScan: $('step-scan'),
    stepVoice: $('step-voice'),
    stepConfirm: $('step-confirm'),
    cameraPreview: $('camera-preview'),
    cameraCanvas: $('camera-canvas'),
    btnSwitchCamera: $('btn-switch-camera'),
    btnCapture: $('btn-capture'),
    ocrResult: $('ocr-result'),
    ocrFields: $('ocr-fields'),
    ocrLoading: $('ocr-loading'),
    btnRescan: $('btn-rescan'),
    btnConfirmScan: $('btn-confirm-scan'),
    transcriptMessages: $('transcript-messages'),
    voiceStatus: $('voice-status'),
    confirmMessage: $('confirm-message'),
    confirmId: $('confirm-id'),
    btnNewVisitor: $('btn-new-visitor'),
    status: $('status'),
};

// ── Telegram Mini App ──────────────────────────────────────────────────────

function initTelegram() {
    const tg = CONFIG.tgApp;
    if (!tg) return;

    tg.ready();
    tg.expand();

    // Parse start_param for business_id
    const startParam = tg.initDataUnsafe?.start_param || '';
    state.businessId = startParam.startsWith('business_')
        ? startParam.replace('business_', '')
        : 'clinic-main';

    // Apply theme
    if (tg.themeParams?.button_color) {
        document.body.style.setProperty('--primary', tg.themeParams.button_color);
    }

    tg.enableClosingConfirmation();
    document.body.classList.add('telegram-webapp');
    console.log('Telegram init, business_id:', state.businessId);
}

// ── Status helpers ─────────────────────────────────────────────────────────

function updateStatus(text) {
    const el = elements.status;
    if (!el) return;
    const span = el.querySelector('.status-text') || el;
    span.textContent = text;
}

function showStep(step) {
    const map = {
        scan: elements.stepScan,
        voice: elements.stepVoice,
        confirm: elements.stepConfirm,
    };
    Object.values(map).forEach(el => el?.classList.add('hidden'));
    map[step]?.classList.remove('hidden');
}

function addMessage(role, text) {
    const container = elements.transcriptMessages;
    if (!container) return;
    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    msg.textContent = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
}

// ── WS1: Durable Object ───────────────────────────────────────────────────

async function connectToDO() {
    try {
        // 1. Get session UUID from Worker
        const resp = await fetch(`${CONFIG.API_URL}/api/ws`);
        if (!resp.ok) throw new Error(`Session init failed: ${resp.status}`);
        const { session_id } = await resp.json();

        // 2. Connect WebSocket to Durable Object
        const wsUrl = CONFIG.API_URL.replace('https://', 'wss://') + `/api/ws/${session_id}`;
        state.doWs = new WebSocket(wsUrl);

        state.doWs.onopen = () => {
            console.log('DO connected, sending start');
            state.doWs.send(JSON.stringify({
                type: 'start',
                business_id: state.businessId,
            }));
        };

        state.doWs.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleDOMessage(msg);
        };

        state.doWs.onerror = (err) => {
            console.error('DO WebSocket error:', err);
            updateStatus('Connection error');
        };

        state.doWs.onclose = () => {
            console.log('DO WebSocket closed');
        };
    } catch (err) {
        console.error('DO connection error:', err);
        updateStatus('Failed to connect');
    }
}

// ── DO Message Handler ─────────────────────────────────────────────────────

function handleDOMessage(msg) {
    console.log('DO ←', msg.type, msg);

    switch (msg.type) {
        case 'welcome':
            state.welcomeText = msg.text;
            state.questions = msg.questions || [];
            state.requiresIdScan = msg.requires_id_scan;
            updateStatus(msg.text || 'Connected');
            showStep('voice');
            // Connect to AssemblyAI with questions baked into the prompt
            connectToAssemblyAI();
            break;

        case 'state':
            state.currentFsmState = msg.state;
            state.currentQuestion = msg.question;
            updateStatus(`Question ${msg.index + 1}/${msg.total}: ${msg.question}`);
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

        case 'summary':
            showSummary(msg.answers, msg.ocr);
            break;

        case 'checkin_complete':
            showDone(msg.registration_id);
            break;

        case 'error':
            updateStatus('Error: ' + msg.message);
            break;

        default:
            console.log('Unknown DO message:', msg);
    }
}

// ── WS2: AssemblyAI Voice Agent ────────────────────────────────────────────

async function connectToAssemblyAI() {
    try {
        // 1. Fetch ephemeral token from Worker (never expose API key)
        const resp = await fetch(`${CONFIG.API_URL}/api/token`);
        if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
        const { token } = await resp.json();

        // 2. Two AudioContexts — Safari requires creation in user gesture,
        //    but we're inside the init flow triggered by Telegram's ready()
        state.captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
        state.playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
        await Promise.all([state.captureCtx.resume(), state.playbackCtx.resume()]);

        // 3. Playback worklet
        state.playback = await addWorklet(state.playbackCtx, PLAYBACK_WORKLET, 'playback');
        state.playback.connect(state.playbackCtx.destination);

        // 4. Microphone
        state.mic = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: false,
                autoGainControl: false,
            },
        });

        // 5. Capture worklet
        const capture = await addWorklet(state.captureCtx, CAPTURE_WORKLET, 'capture');
        state.captureCtx.createMediaStreamSource(state.mic).connect(capture);

        // 6. Connect WebSocket to AssemblyAI
        const url = new URL(CONFIG.VOICE_AGENT_URL);
        url.searchParams.set('token', token);
        state.aaiWs = new WebSocket(url);

        // Send captured audio to AssemblyAI
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
            console.log('AAI connected, sending session.update');
            // Build dynamic system prompt with questions from DO
            const questionsList = (state.questions || [])
                .map((q, i) => `${i + 1}. "${q.text}" (field: ${q.field})`)
                .join('\n');
            const idScanNote = state.requiresIdScan
                ? '\nAfter all questions, ask the visitor to show their ID document to the camera.'
                : '';

            const systemPrompt = `You are a friendly virtual reception assistant for check-in.

FLOW:
1. Greet the visitor warmly
2. Ask each question below ONE AT A TIME, wait for answer, confirm briefly ("Got it", "Understood")
3. After all questions${idScanNote ? ', ask for ID scan if needed' : ''}
4. Summarize all collected information
5. Ask for final confirmation

QUESTIONS TO ASK (in this exact order):
${questionsList}
${idScanNote}

RULES:
- Speak in the visitor's language (detect from their first message)
- Keep sentences short — this is voice, not text
- Never generate your own questions — only ask the ones listed above
- After the visitor answers, confirm briefly then move to next question
- If visitor asks something off-topic, redirect: "Let's continue with the check-in"`;

            state.aaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                    system_prompt: systemPrompt,
                    greeting: state.welcomeText || 'Welcome! Let me help you check in.',
                    voice: { voice_id: 'anna' },
                },
            }));
        };

        state.aaiWs.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            handleAAILogic(msg);
        };

        state.aaiWs.onerror = (err) => {
            console.error('AAI WebSocket error:', err);
        };

        state.aaiWs.onclose = () => {
            console.log('AAI WebSocket closed');
            state.aaiReady = false;
        };

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
            console.log('AAI session ready');
            updateStatus('Voice ready');
            break;

        case 'input.speech.started':
            // Barge-in: stop agent playback
            state.playback?.port.postMessage('stop');
            break;

        case 'reply.audio': {
            // Decode base64 PCM16 and feed to playback worklet
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
            // User finished speaking — forward transcript to DO
            addMessage('user', msg.text);
            if (state.doWs?.readyState === 1) {
                state.doWs.send(JSON.stringify({
                    type: 'user_transcript',
                    text: msg.text,
                }));
            }
            break;

        case 'transcript.agent':
            addMessage('agent', msg.text);
            break;

        case 'session.ended':
            console.log('AAI session ended');
            state.aaiReady = false;
            break;

        case 'session.error':
            console.error('AAI error:', msg.message);
            updateStatus('Voice error: ' + msg.message);
            break;

        default:
            // transcript.user.delta, transcript.agent.delta, tool.call, etc.
            break;
    }
}

// ── Audio worklet helper ───────────────────────────────────────────────────

async function addWorklet(ctx, code, name) {
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    try {
        await ctx.audioWorklet.addModule(url);
    } finally {
        URL.revokeObjectURL(url);
    }
    return new AudioWorkletNode(ctx, name);
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
    } catch (err) {
        console.error('Camera error:', err);
        updateStatus('Camera access denied');
    }
}

function stopCamera() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = null;
    }
}

// ── Capture + Upload (replaces Tesseract.js OCR) ───────────────────────────

async function captureAndUpload() {
    const video = elements.cameraPreview;
    const canvas = elements.cameraCanvas;

    // 1. Draw video frame to canvas
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    // 2. Convert to JPEG blob
    const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8)
    );

    // Show loading
    elements.ocrLoading?.classList.remove('hidden');

    try {
        // 3. Get presigned upload URL from Worker
        const urlResp = await fetch(`${CONFIG.API_URL}/api/upload-url`);
        if (!urlResp.ok) throw new Error('Failed to get upload URL');
        const { upload_url, r2_key } = await urlResp.json();

        // 4. Upload image via PUT to presigned URL
        const putResp = await fetch(upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
        });
        if (!putResp.ok) throw new Error('Upload failed');

        // 5. Send R2 key to DO for server-side OCR
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

// ── OCR Result Display ─────────────────────────────────────────────────────

function displayOCRResult(fields) {
    const container = elements.ocrFields;
    if (!container) return;
    container.innerHTML = '';

    const labels = {
        full_name: 'Name',
        id_number: 'ID Number',
        date_of_birth: 'Date of Birth',
        nationality: 'Nationality',
        expiry_date: 'Expiry Date',
        address: 'Address',
    };

    for (const [key, value] of Object.entries(fields || {})) {
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'field-row';
        row.innerHTML = `<span class="field-label">${labels[key] || key}</span><span class="field-value">${value}</span>`;
        container.appendChild(row);
    }

    elements.ocrResult?.classList.remove('hidden');
    updateStatus('Document scanned — please confirm');
}

// ── Summary & Done ─────────────────────────────────────────────────────────

function showSummary(answers, ocr) {
    updateStatus('Review your check-in');
    // Display summary in transcript area
    let summary = '📋 Check-in Summary:\n';
    if (answers) {
        for (const [q, a] of Object.entries(answers)) {
            summary += `• ${q}: ${a}\n`;
        }
    }
    if (ocr) {
        summary += '\n🪪 Document:\n';
        for (const [k, v] of Object.entries(ocr)) {
            if (v) summary += `• ${k}: ${v}\n`;
        }
    }
    addMessage('agent', summary);
}

function showDone(registrationId) {
    updateStatus('Check-in complete');
    showStep('confirm');
    if (elements.confirmMessage) {
        elements.confirmMessage.textContent = 'Your check-in is complete!';
    }
    if (elements.confirmId) {
        elements.confirmId.textContent = `Registration ID: ${registrationId}`;
    }
    // Disconnect voice
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
    elements.btnSwitchCamera?.addEventListener('click', () => {
        state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
        startCamera();
    });

    // Capture + upload
    elements.btnCapture?.addEventListener('click', captureAndUpload);

    // Rescan
    elements.btnRescan?.addEventListener('click', () => {
        elements.ocrResult?.classList.add('hidden');
        startCamera();
    });

    // Confirm scan
    elements.btnConfirmScan?.addEventListener('click', () => {
        // Tell DO the scan is confirmed
        if (state.doWs?.readyState === 1) {
            state.doWs.send(JSON.stringify({ type: 'id_confirmed' }));
        }
        showStep('voice');
    });

    // File upload fallback (for Telegram WebView)
    const fileUpload = $('file-upload');
    if (fileUpload) {
        fileUpload.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            elements.ocrLoading?.classList.remove('hidden');

            try {
                const urlResp = await fetch(`${CONFIG.API_URL}/api/upload-url`);
                if (!urlResp.ok) throw new Error('Failed to get upload URL');
                const { upload_url, r2_key } = await urlResp.json();

                await fetch(upload_url, {
                    method: 'PUT',
                    headers: { 'Content-Type': file.type || 'image/jpeg' },
                    body: file,
                });

                if (state.doWs?.readyState === 1) {
                    state.doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key }));
                }

                stopCamera();
                updateStatus('Document uploaded, processing...');
            } catch (err) {
                console.error('File upload error:', err);
                updateStatus('Upload failed, please try again');
            } finally {
                elements.ocrLoading?.classList.add('hidden');
            }
        });
    }

    // New visitor
    elements.btnNewVisitor?.addEventListener('click', () => {
        state.answers = {};
        state.ocrData = null;
        elements.transcriptMessages && (elements.transcriptMessages.innerHTML = '');
        // Disconnect and restart
        cleanupAudio();
        if (state.doWs) { state.doWs.close(); state.doWs = null; }
        connectToDO();
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        cleanupAudio();
        state.doWs?.close();
    });
}

// ── Initialize ─────────────────────────────────────────────────────────────

async function init() {
    console.log('Virtualobby dual-WS initializing...');

    // 1. Telegram init + parse start_param
    initTelegram();

    // 2. If no Telegram start_param, use fallback
    if (!state.businessId) {
        state.businessId = 'clinic-main';
    }

    // 3. Init event listeners
    initEventListeners();

    // 4. Show voice step and connect both WebSockets
    showStep('voice');
    updateStatus('Connecting...');

    // 5. Connect to DO first; DO welcome triggers AAI connection
    await connectToDO();

    console.log('Virtualobby initialized, business_id:', state.businessId);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

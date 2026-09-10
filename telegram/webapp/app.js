/**
 * Virtualobby — Voice Reception WebApp
 * 
 * Works as:
 * 1. Telegram Mini App (inside Telegram)
 * 2. Standalone web page (direct URL)
 * 
 * Features:
 * - Camera access for document scanning
 * - Browser-side OCR with Tesseract.js
 * - Voice interaction with AssemblyAI Voice Agent API
 * - Mobile-first responsive design
 */

// ── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
    // Backend API URL (Cloudflare Worker)
    API_URL: 'https://virtualobby-api.alejdro.workers.dev',
    
    // AssemblyAI Voice Agent WebSocket URL
    VOICE_AGENT_URL: 'wss://agents.assemblyai.com/v1/ws',
    AGENT_ID: 'agent_7c0413e77ccc4444b52badf911665aee',
    
    // Telegram Mini App (if available)
    tgApp: window.Telegram?.WebApp || null
};

// ── State ──────────────────────────────────────────────────────────────────

const state = {
    businessType: null,
    ocrData: null,
    visitorData: {},
    ws: null,
    isRecording: false,
    audioContext: null,
    mediaStream: null,
    cameraFacing: 'environment' // 'user' or 'environment'
};

// ── DOM Elements ───────────────────────────────────────────────────────────

const elements = {
    // Steps
    stepBusiness: document.getElementById('step-business'),
    stepScan: document.getElementById('step-scan'),
    stepVoice: document.getElementById('step-voice'),
    stepConfirm: document.getElementById('step-confirm'),
    
    // Business selection
    businessGrid: document.getElementById('business-grid'),
    
    // Camera
    cameraPreview: document.getElementById('camera-preview'),
    cameraCanvas: document.getElementById('camera-canvas'),
    btnSwitchCamera: document.getElementById('btn-switch-camera'),
    btnCapture: document.getElementById('btn-capture'),
    
    // OCR
    ocrResult: document.getElementById('ocr-result'),
    ocrFields: document.getElementById('ocr-fields'),
    ocrLoading: document.getElementById('ocr-loading'),
    btnRescan: document.getElementById('btn-rescan'),
    btnConfirmScan: document.getElementById('btn-confirm-scan'),
    
    // Voice
    transcriptMessages: document.getElementById('transcript-messages'),
    btnVoice: document.getElementById('btn-voice'),
    voiceStatus: document.getElementById('voice-status'),
    
    // Confirmation
    confirmMessage: document.getElementById('confirm-message'),
    confirmId: document.getElementById('confirm-id'),
    btnNewVisitor: document.getElementById('btn-new-visitor'),
    
    // Status
    status: document.getElementById('status')
};

// ── Telegram Mini App Integration ──────────────────────────────────────────

function initTelegram() {
    if (!CONFIG.tgApp) return;
    
    // Set theme
    document.body.style.setProperty('--primary', CONFIG.tgApp.themeParams.button_color || '#2563eb');
    
    // Get user info if available
    const user = CONFIG.tgApp.initDataUnsafe?.user;
    if (user) {
        console.log('Telegram user:', user.first_name);
    }
    
    // Enable closing confirmation
    CONFIG.tgApp.enableClosingConfirmation();
}

// ── Business Selection ─────────────────────────────────────────────────────

function initBusinessSelection() {
    const cards = elements.businessGrid.querySelectorAll('.business-card');
    
    cards.forEach(card => {
        card.addEventListener('click', () => {
            // Remove selected from all
            cards.forEach(c => c.classList.remove('selected'));
            // Add selected to clicked
            card.classList.add('selected');
            // Set business type
            state.businessType = card.dataset.type;
            // Move to next step after short delay
            setTimeout(() => showStep('scan'), 300);
        });
    });
}

// ── Camera ─────────────────────────────────────────────────────────────────

async function startCamera() {
    try {
        // Stop existing stream
        if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(t => t.stop());
        }
        
        const constraints = {
            video: {
                facingMode: state.cameraFacing,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        };
        
        state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        elements.cameraPreview.srcObject = state.mediaStream;
        
    } catch (err) {
        console.error('Camera error:', err);
        alert('Could not access camera. Please check permissions.');
    }
}

function stopCamera() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = null;
    }
}

function captureImage() {
    const video = elements.cameraPreview;
    const canvas = elements.cameraCanvas;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    
    return canvas.toDataURL('image/jpeg', 0.8);
}

// ── OCR with Tesseract.js ──────────────────────────────────────────────────

async function performOCR(imageData) {
    elements.ocrLoading.classList.remove('hidden');
    elements.ocrResult.classList.add('hidden');
    
    try {
        const result = await Tesseract.recognize(imageData, 'eng+spa', {
            logger: info => {
                if (info.status === 'recognizing text') {
                    const pct = Math.round(info.progress * 100);
                    elements.ocrLoading.querySelector('p').textContent = 
                        `Scanning document... ${pct}%`;
                }
            }
        });
        
        const rawText = result.data.text;
        const confidence = result.data.confidence / 100;
        
        // Send to backend for parsing
        const response = await fetch(`${CONFIG.API_URL}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw_text: rawText, confidence })
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.ocrData = data;
            displayOCRResult(data);
        } else {
            alert('OCR failed: ' + (data.error || 'Unknown error'));
        }
        
    } catch (err) {
        console.error('OCR error:', err);
        alert('OCR failed. Please try again.');
    } finally {
        elements.ocrLoading.classList.add('hidden');
    }
}

function displayOCRResult(data) {
    elements.ocrFields.innerHTML = '';
    
    const fields = data.fields || {};
    const fieldLabels = {
        full_name: 'Name',
        id_number: 'ID Number',
        date_of_birth: 'Date of Birth',
        nationality: 'Nationality',
        expiry_date: 'Expiry Date',
        address: 'Address'
    };
    
    for (const [key, value] of Object.entries(fields)) {
        if (value) {
            const row = document.createElement('div');
            row.className = 'field-row';
            row.innerHTML = `
                <span class="field-label">${fieldLabels[key] || key}</span>
                <span class="field-value">${value}</span>
            `;
            elements.ocrFields.appendChild(row);
        }
    }
    
    // Add raw text if few fields extracted
    if (Object.keys(fields).length < 2 && data.raw_text) {
        const rawRow = document.createElement('div');
        rawRow.className = 'field-row';
        rawRow.innerHTML = `
            <span class="field-label">Raw Text</span>
            <span class="field-value" style="font-size: 12px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${data.raw_text.substring(0, 50)}...</span>
        `;
        elements.ocrFields.appendChild(rawRow);
    }
    
    elements.ocrResult.classList.remove('hidden');
    
    // Store visitor data from OCR
    state.visitorData = { ...state.visitorData, ...fields };
}

// ── Voice Agent (AssemblyAI) ───────────────────────────────────────────────

async function connectVoiceAgent() {
    try {
        // Get token from backend
        const tokenRes = await fetch(`${CONFIG.API_URL}/token`);
        const { token } = await tokenRes.json();
        
        if (!token) {
            throw new Error('Could not get voice token');
        }
        
        // Connect to Voice Agent WebSocket
        state.ws = new WebSocket(`${CONFIG.VOICE_AGENT_URL}?token=${token}`);
        
        state.ws.onopen = () => {
            console.log('Voice agent connected');
            
            // Send session.update with agent_id
            state.ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    agent_id: CONFIG.AGENT_ID
                }
            }));
        };
        
        state.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            handleVoiceMessage(msg);
        };
        
        state.ws.onerror = (err) => {
            console.error('Voice error:', err);
        };
        
        state.ws.onclose = () => {
            console.log('Voice agent disconnected');
        };
        
    } catch (err) {
        console.error('Voice connection error:', err);
        // Fallback: show message to use phone
        addMessage('agent', 'Voice connection failed. Please try again or use the manual form.');
    }
}

function handleVoiceMessage(msg) {
    switch (msg.type) {
        case 'session.ready':
            console.log('Session ready');
            break;
            
        case 'transcript.user':
            addMessage('user', msg.transcript);
            break;
            
        case 'transcript.agent':
            addMessage('agent', msg.transcript);
            break;
            
        case 'reply.audio':
            // Play audio response
            playAudio(msg.data);
            break;
            
        case 'reply.done':
            if (msg.status === 'interrupted') {
                console.log('Agent interrupted');
            }
            break;
            
        case 'tool.call':
            handleToolCall(msg);
            break;
            
        default:
            console.log('Voice message:', msg);
    }
}

function handleToolCall(msg) {
    // Handle tool calls from the voice agent
    console.log('Tool call:', msg.name, msg.arguments);
    
    // Send tool result back
    if (msg.name === 'scan_document') {
        // OCR was done earlier, send the data
        state.ws.send(JSON.stringify({
            type: 'tool.result',
            call_id: msg.call_id,
            result: state.ocrData || { success: false, error: 'No document scanned' }
        }));
    } else if (msg.name === 'get_questionnaire') {
        // Fetch questionnaire from backend
        fetch(`${CONFIG.API_URL}/api/questionnaire?business_type=${state.businessType}`)
            .then(res => res.json())
            .then(data => {
                state.ws.send(JSON.stringify({
                    type: 'tool.result',
                    call_id: msg.call_id,
                    result: data
                }));
            });
    } else if (msg.name === 'register_visitor') {
        // Register visitor
        fetch(`${CONFIG.API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                visitor_data: state.visitorData,
                business_type: state.businessType,
                confirmed: true
            })
        })
        .then(res => res.json())
        .then(data => {
            state.ws.send(JSON.stringify({
                type: 'tool.result',
                call_id: msg.call_id,
                result: data
            }));
            
            // Show confirmation
            if (data.success) {
                showConfirmation(data);
            }
        });
    }
}

async function startRecording() {
    try {
        state.mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                sampleRate: 24000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            } 
        });
        
        state.audioContext = new AudioContext({ sampleRate: 24000 });
        const source = state.audioContext.createMediaStreamSource(state.mediaStream);
        const processor = state.audioContext.createScriptProcessor(1024, 1, 1);
        
        processor.onaudioprocess = (e) => {
            if (!state.isRecording || !state.ws) return;
            
            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(inputData.length);
            
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // Convert to base64 and send
            const bytes = new Uint8Array(pcm16.buffer);
            const base64 = btoa(String.fromCharCode(...bytes));
            
            state.ws.send(JSON.stringify({
                type: 'input.audio',
                audio: base64
            }));
        };
        
        source.connect(processor);
        processor.connect(state.audioContext.destination);
        
        state.isRecording = true;
        elements.btnVoice.classList.add('recording');
        elements.voiceStatus.classList.add('active');
        
    } catch (err) {
        console.error('Recording error:', err);
        alert('Could not access microphone. Please check permissions.');
    }
}

function stopRecording() {
    state.isRecording = false;
    
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
    }
    
    if (state.audioContext) {
        state.audioContext.close();
    }
    
    elements.btnVoice.classList.remove('recording');
    elements.voiceStatus.classList.remove('active');
}

function playAudio(base64Audio) {
    const audio = new Audio(`data:audio/wav;base64,${base64Audio}`);
    audio.play().catch(err => console.error('Audio play error:', err));
}

// ── UI Helpers ─────────────────────────────────────────────────────────────

function showStep(step) {
    // Hide all steps
    elements.stepBusiness.classList.add('hidden');
    elements.stepScan.classList.add('hidden');
    elements.stepVoice.classList.add('hidden');
    elements.stepConfirm.classList.add('hidden');
    
    // Show selected step
    switch (step) {
        case 'business':
            elements.stepBusiness.classList.remove('hidden');
            break;
        case 'scan':
            elements.stepScan.classList.remove('hidden');
            startCamera();
            break;
        case 'voice':
            elements.stepVoice.classList.remove('hidden');
            connectVoiceAgent();
            break;
        case 'confirm':
            elements.stepConfirm.classList.remove('hidden');
            break;
    }
    
    // Update status
    updateStatus(step);
}

function updateStatus(step) {
    const statusText = {
        'business': 'Select business type',
        'scan': 'Scan your document',
        'voice': 'Answer questions',
        'confirm': 'Registration complete'
    };
    
    elements.status.querySelector('.status-text').textContent = statusText[step] || 'Ready';
}

function addMessage(role, text) {
    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    msg.textContent = text;
    elements.transcriptMessages.appendChild(msg);
    elements.transcriptMessages.scrollTop = elements.transcriptMessages.scrollHeight;
}

function showConfirmation(data) {
    elements.confirmMessage.textContent = data.message || 'Registration successful!';
    elements.confirmId.textContent = `ID: ${data.submission_id}`;
    showStep('confirm');
}

// ── Event Listeners ────────────────────────────────────────────────────────

function initEventListeners() {
    // Camera switch
    elements.btnSwitchCamera.addEventListener('click', () => {
        state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
        startCamera();
    });
    
    // Capture
    elements.btnCapture.addEventListener('click', async () => {
        const imageData = captureImage();
        stopCamera();
        await performOCR(imageData);
    });
    
    // Rescan
    elements.btnRescan.addEventListener('click', () => {
        elements.ocrResult.classList.add('hidden');
        startCamera();
    });
    
    // Confirm scan
    elements.btnConfirmScan.addEventListener('click', () => {
        showStep('voice');
    });
    
    // Voice button (hold to speak)
    elements.btnVoice.addEventListener('mousedown', startRecording);
    elements.btnVoice.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startRecording();
    });
    
    elements.btnVoice.addEventListener('mouseup', stopRecording);
    elements.btnVoice.addEventListener('touchend', (e) => {
        e.preventDefault();
        stopRecording();
    });
    
    // File upload (fallback for Telegram WebView)
    const fileUpload = document.getElementById('file-upload');
    if (fileUpload) {
        fileUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            // Convert to base64
            const reader = new FileReader();
            reader.onload = async () => {
                stopCamera();
                await performOCR(reader.result);
            };
            reader.readAsDataURL(file);
        });
    }
    
    // New visitor
    elements.btnNewVisitor.addEventListener('click', () => {
        state.businessType = null;
        state.ocrData = null;
        state.visitorData = {};
        elements.transcriptMessages.innerHTML = '';
        
        // Reset business selection
        document.querySelectorAll('.business-card').forEach(c => c.classList.remove('selected'));
        
        showStep('business');
    });
}

// ── Initialize ─────────────────────────────────────────────────────────────

function init() {
    console.log('Virtualobby initializing...');
    
    // Initialize Telegram if available
    initTelegram();
    
    // Initialize business selection
    initBusinessSelection();
    
    // Initialize event listeners
    initEventListeners();
    
    // Show first step
    showStep('business');
    
    console.log('Virtualobby ready');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

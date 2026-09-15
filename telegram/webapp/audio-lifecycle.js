// The caller owns these resources only after prepareAudio resolves. Until
// then, every failure path (including a late permission grant) releases them.
function stopMicrophone(stream) {
    let tracks;
    try { tracks = stream?.getTracks() || []; } catch (_) { return; }
    for (const track of tracks) {
        try { track.stop(); } catch (_) { /* Still stop the remaining tracks. */ }
    }
}

function closeContext(context) {
    try {
        Promise.resolve(context?.close()).catch(() => {});
    } catch (_) { /* A closed/broken context must not prevent other cleanup. */ }
}

export function prepareAudio({
    sampleRate = 24000,
    timeoutMs = 10000,
    signal,
    AudioContextClass = globalThis.AudioContext,
    getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    return new Promise((resolve, reject) => {
        let captureCtx, playbackCtx, mic, timer;
        let settled = false;
        let completed = 0;

        const removeWaiters = () => {
            if (timer !== undefined) clearTimer(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            removeWaiters();
            stopMicrophone(mic);
            closeContext(captureCtx);
            closeContext(playbackCtx);
            reject(error);
        };
        const onAbort = () => fail(signal.reason ?? new DOMException('Audio preparation aborted', 'AbortError'));
        const ready = () => {
            if (settled || ++completed !== 3) return;
            settled = true;
            removeWaiters();
            resolve({ captureCtx, playbackCtx, mic });
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }

        try {
            signal?.addEventListener('abort', onAbort, { once: true });
            timer = setTimer(() => fail(new Error('Audio setup timed out')), timeoutMs);
            captureCtx = new AudioContextClass({ sampleRate });
            playbackCtx = new AudioContextClass({ sampleRate });

            // No await before these calls: both activations and the permission
            // request run in the original Start button's user-gesture stack.
            // Attach each rejection handler immediately, even if the next
            // operation throws synchronously.
            Promise.resolve(captureCtx.resume()).then(ready, fail);
            Promise.resolve(playbackCtx.resume()).then(ready, fail);
            Promise.resolve(getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            })).then((stream) => {
                if (settled) {
                    stopMicrophone(stream);
                    return;
                }
                mic = stream;
                ready();
            }, fail);
        } catch (error) {
            fail(error);
        }
    });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAudio } from '../telegram/webapp/audio-lifecycle.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function drain() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function microphone() {
    const tracks = [0, 1].map(() => ({ stops: 0, stop() { this.stops++; } }));
    return { tracks, getTracks: () => tracks };
}

function fixture({ constructorFailsAt, resumeThrowsAt, gumThrows, closeRejects = false } = {}) {
    const calls = [], contexts = [], timers = new Map();
    const resumes = [deferred(), deferred()];
    const permission = deferred();
    const controller = new AbortController();
    const signal = controller.signal;
    let listenerCount = 0, nextTimer = 0, constructors = 0;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { listenerCount++; return add(...args); };
    signal.removeEventListener = (...args) => { if (listenerCount) listenerCount--; return remove(...args); };
    class AudioContextMock {
        constructor(options) {
            const index = constructors++;
            calls.push(`construct:${index}`);
            if (index === constructorFailsAt) throw new Error('synthetic constructor failure');
            this.index = index; this.options = options; this.closes = 0;
            contexts.push(this);
        }
        resume() {
            calls.push(`resume:${this.index}`);
            if (this.index === resumeThrowsAt) throw new Error('synthetic resume throw');
            return resumes[this.index].promise;
        }
        close() {
            this.closes++;
            return closeRejects ? Promise.reject(new Error('synthetic close rejection')) : Promise.resolve();
        }
    }
    const options = {
        sampleRate: 24000, timeoutMs: 10000, signal,
        AudioContextClass: AudioContextMock,
        getUserMedia(constraints) {
            calls.push('microphone');
            assert.equal(constraints.audio.channelCount, 1);
            assert.equal(constraints.audio.echoCancellation, true);
            if (gumThrows) throw new Error('synthetic microphone throw');
            return permission.promise;
        },
        setTimer(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimer(id) { timers.delete(id); },
    };
    return {
        options, calls, contexts, resumes, permission, controller, timers,
        get listenerCount() { return listenerCount; },
        start() { return prepareAudio(options); },
        async timeout() {
            for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
            await drain();
        },
        activate() { resumes.forEach(resume => resume.resolve()); },
        assertReleased() {
            assert.ok(contexts.every(context => context.closes === 1));
            assert.equal(timers.size, 0);
            assert.equal(listenerCount, 0);
        },
    };
}

test('starts both audio activations and permission synchronously, then hands ownership to caller', async () => {
    const f = fixture(), mic = microphone();
    const pending = f.start();
    assert.deepEqual(f.calls, ['construct:0', 'construct:1', 'resume:0', 'resume:1', 'microphone']);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, 10000);
    f.permission.resolve(mic); f.activate();
    const result = await pending;
    assert.equal(result.captureCtx, f.contexts[0]);
    assert.equal(result.playbackCtx, f.contexts[1]);
    assert.equal(result.mic, mic);
    assert.equal(f.contexts[0].options.sampleRate, 24000);
    assert.equal(f.timers.size, 0);
    assert.equal(f.listenerCount, 0);
    f.controller.abort(); await drain();
    assert.ok(f.contexts.every(context => context.closes === 0));
    assert.ok(mic.tracks.every(track => track.stops === 0));
});

test('permission denial rejects and releases both contexts', async () => {
    const f = fixture(), error = new Error('synthetic permission denial');
    const rejected = assert.rejects(f.start(), value => value === error);
    f.activate(); f.permission.reject(error);
    await rejected; f.assertReleased();
});

test('activation rejection stops a microphone that arrives afterwards', async () => {
    const f = fixture(), mic = microphone();
    const rejected = assert.rejects(f.start(), /synthetic activation failure/);
    f.resumes[0].reject(new Error('synthetic activation failure'));
    await rejected; f.assertReleased();
    f.permission.resolve(mic);
    f.resumes[1].reject(new Error('later activation failure'));
    await drain();
    assert.ok(mic.tracks.every(track => track.stops === 1));
});

test('one total timeout covers indefinitely pending activation and permission', async () => {
    const f = fixture(), mic = microphone();
    const rejected = assert.rejects(f.start(), /Audio setup timed out/);
    await f.timeout(); await rejected; f.assertReleased();
    f.permission.resolve(mic); f.activate(); await drain();
    assert.ok(mic.tracks.every(track => track.stops === 1));
    f.assertReleased();
});

test('timeout stops an acquired microphone when audio activation remains pending', async () => {
    const f = fixture(), mic = microphone();
    const rejected = assert.rejects(f.start(), /Audio setup timed out/);
    f.permission.resolve(mic); await drain();
    await f.timeout(); await rejected;
    assert.ok(mic.tracks.every(track => track.stops === 1));
    f.assertReleased();
});

test('an already aborted request opens no audio context and requests no microphone', async () => {
    const f = fixture(), reason = new Error('synthetic cancellation');
    f.controller.abort(reason);
    await assert.rejects(f.start(), value => value === reason);
    assert.deepEqual(f.calls, []);
    f.assertReleased();
});

test('cancellation releases current resources and stops a late permission grant', async () => {
    const f = fixture(), mic = microphone();
    const rejected = assert.rejects(f.start(), error => error.name === 'AbortError');
    f.controller.abort(); await rejected; f.assertReleased();
    f.permission.resolve(mic); f.activate(); await drain();
    assert.ok(mic.tracks.every(track => track.stops === 1));
});

test('cancellation stops a microphone already acquired before activation completed', async () => {
    const f = fixture(), mic = microphone();
    const rejected = assert.rejects(f.start(), error => error.name === 'AbortError');
    f.permission.resolve(mic); await drain();
    f.controller.abort(); await rejected;
    assert.ok(mic.tracks.every(track => track.stops === 1));
    f.assertReleased();
});

test('a partial constructor failure releases the first context without requesting microphone', async () => {
    const f = fixture({ constructorFailsAt: 1 });
    await assert.rejects(f.start(), /synthetic constructor failure/);
    assert.equal(f.contexts.length, 1);
    assert.deepEqual(f.calls, ['construct:0', 'construct:1']);
    f.assertReleased();
});

test('a synchronous second resume failure still observes a first resume rejection', async () => {
    const f = fixture({ resumeThrowsAt: 1 });
    f.resumes[0].reject(new Error('first activation rejection'));
    await assert.rejects(f.start(), /synthetic resume throw/);
    assert.ok(!f.calls.includes('microphone'));
    await drain(); f.assertReleased();
});

test('a synchronous microphone failure releases contexts and observes later activation rejections', async () => {
    const f = fixture({ gumThrows: true });
    await assert.rejects(f.start(), /synthetic microphone throw/);
    f.resumes.forEach(resume => resume.reject(new Error('later activation rejection')));
    await drain(); f.assertReleased();
});

test('close rejection and one broken track do not prevent remaining resource cleanup', async () => {
    const f = fixture({ closeRejects: true }), mic = microphone();
    mic.tracks[0].stop = () => { throw new Error('synthetic track stop failure'); };
    const rejected = assert.rejects(f.start(), /Audio setup timed out/);
    f.permission.resolve(mic); await drain();
    await f.timeout(); await rejected; await drain();
    assert.equal(mic.tracks[1].stops, 1);
    f.assertReleased();
});

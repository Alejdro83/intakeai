import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientHarness, deferred, settle } from './client-harness.mjs';

const welcome = {
  type: 'welcome', business_name: 'Synthetic reception', requires_id_scan: false,
  questions: [{ field: 'visit_reason', text: 'What brings you here?' }],
};
const tokenResponse = async () => ({ ok: true, status: 200, json: async () => ({ token: 'synthetic-test-value' }) });

async function load(t, options) {
  const h = await createClientHarness(options);
  t.after(async () => { h.app.cleanupAudio(); await settle(); await h.dispose(); });
  return h;
}

async function beginVoice(h) {
  await h.app.startCheckin();
  h.app.state.doWs.open();
  h.app.state.doWs.receive(welcome);
  await settle();
}

function assertRetryAndReleased(h) {
  assert.equal(h.app.state.voiceConnecting, false);
  assert.equal(h.app.state.mic, null);
  assert.equal(h.app.state.captureCtx, null);
  assert.equal(h.app.state.playbackCtx, null);
  assert.ok(h.streams.every(stream => stream.track.readyState === 'ended'));
  assert.ok(h.contexts.every(context => context.state === 'closed'));
  assert.equal(h.nodes.get('step-start').classList.contains('hidden'), false);
  assert.equal(h.nodes.get('btn-start').disabled, false);
  assert.match(h.nodes.get('status-text').textContent, /timed? out|timeout|reconnect/i);
}

test('voice setup timeout also covers an indefinitely pending token request', async t => {
  const token = deferred();
  const h = await load(t, { fetch: () => token.promise });
  await beginVoice(h);
  assert.equal(h.app.state.voiceConnecting, true);
  await h.tick(10001);
  assertRetryAndReleased(h);
  // The provider can still fail after cancellation; its old rejection must
  // be consumed without touching a future attempt or becoming unhandled.
  token.reject(new Error('late synthetic token failure'));
  await settle();
});

test('voice setup timeout covers a worklet module that never settles', async t => {
  const worklet = deferred();
  const h = await load(t, { fetch: tokenResponse, workletAddModule: () => worklet.promise });
  await beginVoice(h);
  assert.equal(h.app.state.voiceConnecting, true);
  await h.tick(10001);
  assertRetryAndReleased(h);
  worklet.reject(new Error('late synthetic worklet failure'));
  await settle();
});

test('a cancelled attempt failing to load a worklet cannot close the next attempt audio', async t => {
  const oldWorklet = deferred();
  let modules = 0;
  const h = await load(t, {
    fetch: tokenResponse,
    workletAddModule: () => ++modules === 1 ? oldWorklet.promise : Promise.resolve(),
  });
  await beginVoice(h);
  assert.equal(modules, 1);
  h.app.cleanupAudio();
  h.app.state.sessionId = 'synthetic-replacement-session';
  await h.app.primeAudio();
  h.app.handleDOMessage(welcome);
  await settle();
  const newMic = h.app.state.mic;
  const newCapture = h.app.state.captureCtx, newPlayback = h.app.state.playbackCtx;
  const newVoice = h.app.state.aaiWs;
  assert.ok(newVoice, 'replacement voice setup reached its mocked socket');
  oldWorklet.reject(new Error('old audio context was closed'));
  await settle();
  assert.equal(h.app.state.mic, newMic);
  assert.equal(newMic.track.stopCalls, 0);
  assert.equal(newCapture.state, 'running');
  assert.equal(newPlayback.state, 'running');
  assert.equal(h.app.state.aaiWs, newVoice);
  assert.equal(newVoice.closeCalls.length, 0);
});

test('a backend socket stuck connecting releases microphone and offers a retry after ten seconds', async t => {
  const h = await load(t);
  await h.app.startCheckin();
  const backend = h.app.state.doWs;
  assert.equal(backend.readyState, h.FakeWebSocket.CONNECTING);
  assert.ok(h.streams.some(stream => stream.track.readyState === 'live'));
  await h.tick(10001);
  assertRetryAndReleased(h);
  assert.equal(backend.closeCalls.length, 1);
  assert.equal(h.app.state.doWs, null);
});

test('a voice confirmation completing before the simultaneous manual ACK preserves the success screen', async t => {
  const h = await load(t);
  h.app.state.sessionId = 'synthetic-simultaneous-confirmation';
  const backend = h.socket('wss://backend.invalid/');
  h.app.state.doWs = backend;
  h.app.state.aaiWs = h.socket('wss://voice.invalid/');
  h.app.state.fsmState = 'confirming';
  const voiceConfirmation = h.app.queueToolResult({
    name: 'confirm_registration', call_id: 'synthetic-voice-confirmation', arguments: {},
  });
  const voiceOperation = backend.sent.find(message => message.type === 'confirm');
  assert.ok(voiceOperation?.operation_id);
  const manualConfirmation = h.app.confirmSummary();
  assert.equal(backend.sent.filter(message => message.type === 'confirm').length, 2);
  h.app.handleDOMessage({ type: 'operation_result', operation_id: voiceOperation.operation_id, success: true });
  h.app.handleDOMessage({ type: 'checkin_complete', registration_id: 'synthetic-registration' });
  await Promise.all([voiceConfirmation, manualConfirmation]);
  await settle();
  assert.equal(h.app.state.checkinDone, true);
  assert.equal(h.nodes.get('status-text').textContent, 'Check-in complete');
  assert.equal(h.nodes.get('confirm-message').textContent, 'Your check-in is complete!');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientHarness, FakeStorage, settle } from './client-harness.mjs';

async function load(t, options) {
  const harness = await createClientHarness(options);
  t.after(() => harness.dispose());
  return harness;
}
function pair(harness) {
  const backend = harness.socket('wss://backend.invalid/');
  const voice = harness.socket('wss://voice.invalid/');
  harness.app.state.doWs = backend;
  harness.app.state.aaiWs = voice;
  harness.app.state.aaiReady = true;
  harness.app.state.questions = [{ id: 'q1', field: 'appointment', text: 'Do you have an appointment?', type: 'text' }];
  return { backend, voice };
}
function answerCall(callId = 'call-one') {
  return { type: 'tool.call', call_id: callId, name: 'submit_answer', arguments: { field: 'appointment', answer: 'yes' } };
}
function acknowledge(app, operation, success = true, error = undefined) {
  assert.ok(operation?.operation_id, 'Mutation must carry an operation ID');
  app.handleDOMessage({ type: 'operation_result', operation_id: operation.operation_id, success, ...(error ? { error } : {}) });
}
function toolResults(socket) { return socket.sent.filter(message => message.type === 'tool.result').map(message => ({ ...message, result: JSON.parse(message.result) })); }
function lastOperation(socket, type) { return socket.sent.filter(message => message.type === type).at(-1); }

test('summary after the documents step shows the confirmation screen', async t => {
  const h = await load(t); pair(h);
  h.app.handleDOMessage({type:'request_documents',prompt:'Synthetic document request'});
  assert.equal(h.app.elements.stepDocuments.classList.contains('hidden'),false);
  h.app.handleDOMessage({type:'summary',answers:{q1:'synthetic answer'},ocr:{}});
  assert.equal(h.app.elements.stepDocuments.classList.contains('hidden'),true);
  assert.equal(h.app.elements.stepVoice.classList.contains('hidden'),false);
  assert.equal(h.app.elements.summaryActions.classList.contains('hidden'),false);
});

test('importing the real client waits for a user gesture without starting devices or networking', async t => {
  const h = await load(t);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.streams.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.documentEvents.events.get('DOMContentLoaded')?.length, 1);
  await h.boot();
  assert.equal(h.contexts.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.nodes.get('btn-start').events.get('click')?.length, 1);
});

test('tool success waits for both durable acknowledgement and reply.done (ACK first)', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  h.app.queueToolResult(answerCall());
  await settle();
  assert.equal(toolResults(voice).length, 0);
  acknowledge(h.app, lastOperation(backend, 'user_transcript'));
  await settle();
  assert.equal(toolResults(voice).length, 0, 'ACK alone must not respond during the current reply');
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(toolResults(voice).length, 1);
  assert.equal(toolResults(voice)[0].result.success, true);
});

test('tool success waits for a late durable acknowledgement (reply.done first)', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  h.app.queueToolResult(answerCall());
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(toolResults(voice).length, 0, 'Delivery to an open socket is not proof of persistence');
  acknowledge(h.app, lastOperation(backend, 'user_transcript'));
  await settle();
  assert.equal(toolResults(voice).length, 1);
  assert.equal(toolResults(voice)[0].result.success, true);
});

test('duplicate tool call IDs do not apply the same answer twice before or after ACK', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  h.app.queueToolResult(answerCall('duplicate'));
  h.app.queueToolResult(answerCall('duplicate'));
  await settle();
  assert.equal(backend.sent.filter(message => message.type === 'user_transcript').length, 1);
  acknowledge(h.app, lastOperation(backend, 'user_transcript'));
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  h.app.queueToolResult(answerCall('duplicate'));
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(backend.sent.filter(message => message.type === 'user_transcript').length, 1);
  assert.ok(toolResults(voice).length >= 1);
  assert.ok(toolResults(voice).every(message => message.result.success === true));
});

test('a rejected operation is reported as failure instead of optimistic success', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  h.app.queueToolResult(answerCall());
  acknowledge(h.app, lastOperation(backend, 'user_transcript'), false, 'Question already changed');
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(toolResults(voice).length, 1);
  assert.equal(toolResults(voice)[0].result.success, false);
  assert.match(toolResults(voice)[0].result.error, /Question already changed/);
});

test('an unanswered operation times out and reports failure', async t => {
  const h = await load(t); const { voice } = pair(h);
  h.app.queueToolResult(answerCall());
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await h.tick(30000);
  assert.equal(toolResults(voice).length, 1);
  assert.equal(toolResults(voice)[0].result.success, false);
  assert.match(toolResults(voice)[0].result.error, /tim(e|ed).*out|timeout/i);
});

test('a closed backend never generates success for a tool call', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  backend.readyState = h.FakeWebSocket.CLOSED;
  h.app.queueToolResult(answerCall());
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(backend.sent.length, 0);
  assert.equal(toolResults(voice).length, 1);
  assert.equal(toolResults(voice)[0].result.success, false);
});

test('ACKs with another operation ID cannot settle a pending mutation', async t => {
  const h = await load(t); const { backend } = pair(h);
  let settled = false;
  const operation = h.app.requestOperation('confirm', {}, 'expected-operation').then(result => { settled = true; return result; });
  h.app.handleDOMessage({ type: 'operation_result', operation_id: 'unrelated-operation', success: true });
  await settle();
  assert.equal(settled, false);
  acknowledge(h.app, lastOperation(backend, 'confirm'));
  assert.equal((await operation).success, true);
});

test('a socket that closes during send rejects the operation without waiting for a timeout', async t => {
  const h = await load(t); const { backend } = pair(h);
  backend.send = () => { throw new Error('Socket closed during send'); };
  await assert.rejects(h.app.requestOperation('confirm'), /Socket closed during send|connect|send/i);
});

test('interrupted replies discard late tool results instead of leaking them into another turn', async t => {
  const h = await load(t); const { backend, voice } = pair(h);
  h.app.queueToolResult(answerCall());
  h.app.handleAAILogic({ type: 'reply.done', status: 'interrupted' });
  acknowledge(h.app, lastOperation(backend, 'user_transcript'));
  await settle();
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await settle();
  assert.equal(toolResults(voice).length, 0);
});

test('cleanup closes the captured old voice socket and leaves a newer connection intact', async t => {
  const h = await load(t); const { voice: oldVoice } = pair(h);
  h.app.cleanupAudio();
  const newVoice = h.socket('wss://next-voice.invalid/');
  h.app.state.aaiWs = newVoice;
  h.app.state.aaiReady = true;
  await h.tick(2100);
  assert.equal(oldVoice.closeCalls.length, 1);
  assert.equal(newVoice.closeCalls.length, 0);
  assert.equal(h.app.state.aaiWs, newVoice);
  assert.equal(h.app.state.aaiReady, true);
});

test('cleanup cancels pending operations and discards old visitor tool results', async t => {
  const h = await load(t); const { backend } = pair(h);
  h.app.queueToolResult(answerCall());
  const oldOperation = lastOperation(backend, 'user_transcript');
  h.app.cleanupAudio();
  const nextVoice = h.socket('wss://next-voice.invalid/');
  h.app.state.aaiWs = nextVoice;
  h.app.state.aaiReady = true;
  acknowledge(h.app, oldOperation);
  await settle();
  h.app.handleAAILogic({ type: 'reply.done', status: 'completed' });
  await h.tick(30000);
  assert.equal(toolResults(nextVoice).length, 0);
  assert.equal(h.app.state.pendingToolResults.length, 0);
});

test('manual confirmation stays available when the backend is disconnected', async t => {
  const h = await load(t); h.app.initEventListeners();
  h.app.handleDOMessage({ type: 'summary', answers: { appointment: 'yes' }, ocr: {} });
  await h.nodes.get('btn-confirm-summary').click();
  assert.equal(h.nodes.get('btn-confirm-summary').disabled, false);
  assert.match(h.nodes.get('status-text').textContent, /connect|retry|again|failed/i);
});

test('manual confirmation waits for ACK and recovers after a server rejection', async t => {
  const h = await load(t); const { backend } = pair(h); h.app.initEventListeners();
  const button = h.nodes.get('btn-confirm-summary');
  const click = button.click(); await settle();
  assert.equal(button.disabled, true);
  acknowledge(h.app, lastOperation(backend, 'confirm'), false, 'Please review the answers');
  await click;
  assert.equal(button.disabled, false);
  assert.match(h.nodes.get('status-text').textContent, /Please review the answers/);
});

test('manual confirmation becomes retryable after an ACK timeout', async t => {
  const h = await load(t); pair(h); h.app.initEventListeners();
  const button = h.nodes.get('btn-confirm-summary');
  const click = button.click(); await settle();
  assert.equal(button.disabled, true);
  await h.tick(30000); await click;
  assert.equal(button.disabled, false);
});

test('the documents Continue button also recovers from disconnection', async t => {
  const h = await load(t); h.app.initEventListeners();
  await h.nodes.get('btn-documents-continue').click();
  assert.equal(h.nodes.get('btn-documents-continue').disabled, false);
  assert.match(h.nodes.get('status-text').textContent, /connect|retry|again|failed/i);
});

test('reload resumes a nonexpired reference for the same business', async t => {
  const storage = new FakeStorage();
  let saved, originalId;
  const first = await createClientHarness({ storage });
  try {
    first.app.state.businessId = 'business-a';
    await first.app.connectToDO(); first.app.state.doWs.open();
    originalId = first.app.state.sessionId;
    saved = JSON.parse(storage.getItem(first.app.SESSION_STORAGE_KEY));
    assert.equal(saved.id, originalId);
    assert.equal(saved.businessId, 'business-a');
    assert.ok(saved.expiresAt > first.clock.now);
    assert.equal(first.app.state.doWs.sent[0].type, 'start');
    assert.deepEqual(Object.keys(saved).sort(), ['businessId', 'expiresAt', 'id']);
  } finally { await first.dispose(); }
  const second = await load(t, { storage });
  second.app.state.businessId = 'business-a';
  await second.app.connectToDO(); second.app.state.doWs.open();
  assert.equal(second.app.state.sessionId, originalId);
  assert.equal(second.app.state.doWs.sent[0].type, 'resume');
});

test('a stored session belonging to another business is never resumed', async t => {
  const h = await load(t); h.app.state.businessId = 'business-b';
  h.storage.setItem(h.app.SESSION_STORAGE_KEY, JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', businessId: 'business-a', expiresAt: h.clock.now + 60000 }));
  await h.app.connectToDO(); h.app.state.doWs.open();
  assert.notEqual(h.app.state.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(h.app.state.doWs.sent[0].type, 'start');
  assert.equal(h.app.state.doWs.sent[0].business_id, 'business-b');
});

test('expired session references start a fresh administrative session', async t => {
  const h = await load(t); h.app.state.businessId = 'business-a';
  h.storage.setItem(h.app.SESSION_STORAGE_KEY, JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', businessId: 'business-a', expiresAt: h.clock.now - 1 }));
  await h.app.connectToDO(); h.app.state.doWs.open();
  assert.notEqual(h.app.state.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(h.app.state.doWs.sent[0].type, 'start');
});

test('unavailable sessionStorage does not prevent a new connection', async t => {
  const storage = { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); }, removeItem() { throw new Error('storage blocked'); } };
  const h = await load(t, { storage }); h.app.state.businessId = 'business-a';
  await h.app.connectToDO(); h.app.state.doWs.open();
  assert.ok(h.app.state.sessionId);
  assert.equal(h.app.state.doWs.sent[0].type, 'start');
});

test('restored snapshots restore business, answers and interview progress before voice continues', async t => {
  const h = await load(t); pair(h);
  h.app.state.businessId = 'business-a';
  const snapshot = {
    type: 'session_restored', business_id: 'business-a', business_name: 'Synthetic reception',
    welcome_message: 'Hello', voice_id: 'anna', voice_persona: 'concise', requires_id_scan: true,
    questions: [{ id: 'q1', field: 'appointment', text: 'Do you have an appointment?', type: 'text' }, { id: 'q2', field: 'reason', text: 'What brings you here?', type: 'text' }],
    answers: { appointment: 'yes' }, ocr_data: { name: 'Synthetic Visitor' }, current_question_index: 1, state: 'asking_questions',
  };
  h.app.handleDOMessage(snapshot); await settle();
  assert.equal(h.app.state.businessName, snapshot.business_name);
  assert.deepEqual(h.app.state.questions, snapshot.questions);
  assert.deepEqual(h.app.state.answers, snapshot.answers);
  assert.deepEqual(h.app.state.ocrData, snapshot.ocr_data);
  assert.equal(h.app.state.scanCompleted, true);
  const prompt = h.app.buildInterviewPrompt();
  assert.match(prompt, /appointment/);
  assert.match(prompt, /yes/);
  assert.match(prompt, /resume|already|answered|remaining|continue/i);
  // _handleResume follows the snapshot with the current FSM event; that event
  // selects the screen after the client has restored the voice context.
  h.app.handleDOMessage({ type: 'state', state: 'asking_questions', index: 1, total: 2, question: snapshot.questions[1].text });
  assert.equal(h.nodes.get('step-voice').classList.contains('hidden'), false);
  assert.match(h.nodes.get('status-text').textContent, /Question 2\/2/);
});

test('repeated OCR completion notifications hand off to the voice interview only once', async t => {
  const h = await load(t); const { voice } = pair(h);
  h.app.state.requiresIdScan = true;
  h.app.state.micMuted = true;
  const ready = { type: 'questions_ready', questions: [{ id: 'q1', field: 'appointment', text: 'Do you have an appointment?' }], ocr_data: { name: 'Synthetic Visitor' } };
  h.app.handleDOMessage({ type: 'ocr_result', fields: ready.ocr_data, success: true });
  h.app.handleDOMessage(ready);
  h.app.handleDOMessage(ready);
  h.app.proceedToInterview();
  await settle();
  assert.equal(voice.sent.filter(message => message.type === 'session.update').length, 1);
  assert.equal(voice.sent.filter(message => message.type === 'reply.create').length, 1);
  assert.equal(h.app.state.micMuted, false);
});

test('completion removes the stored reference and a new visitor requires a new Start click', async t => {
  const h = await load(t); pair(h); h.app.initEventListeners();
  h.storage.setItem(h.app.SESSION_STORAGE_KEY, JSON.stringify({ id: 'old-id', businessId: 'business-a', expiresAt: h.clock.now + 60000 }));
  h.app.showDone('synthetic-registration');
  assert.equal(h.storage.getItem(h.app.SESSION_STORAGE_KEY), null);
  assert.equal(h.app.state.checkinDone, true);
  await h.nodes.get('btn-new-visitor').click();
  assert.equal(h.app.state.checkinDone, false);
  assert.equal(h.app.state.scanCompleted, false);
  assert.deepEqual(h.app.state.answers, {});
  assert.equal(h.nodes.get('step-start').classList.contains('hidden'), false);
  assert.equal(h.nodes.get('btn-start').disabled, false);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.requests.length, 0);
});

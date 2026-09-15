import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CheckinSession } from '../api/checkin-do.js';

// Tests use synthetic records, in-memory stores and sockets. No Cloudflare,
// network, voice, patient data, dependency installation or real timers.
function fixture(t, { fsmState = 'asking_questions', requiresDocuments = false } = {}) {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in unit tests'); });
  const questions = [
    { id: 'q1', question_text: 'Synthetic question one?', field_key: 'first', validation_type: 'text' },
    { id: 'q2', question_text: 'Synthetic question two?', field_key: 'second', validation_type: 'text' },
  ];
  const config = { name: 'Synthetic Clinic', welcome_message: 'Synthetic welcome', voice_id: 'anna', voice_persona: 'concise',
    requires_id_scan: 1, requires_documents: requiresDocuments ? 1 : 0,
    webhook_url: 'https://never-requested.invalid/webhook', webhook_secret: '[SYNTHETIC-NOT-A-SECRET]' };
  let durable = { businessId: 'business-one', fsmState, businessConfig: config, questions, currentQuestionIndex: 0,
    answers: {}, ocrData: { name: 'Synthetic Visitor' }, operationReceipts: {}, pendingRegistration: null };
  if (fsmState === 'confirming' || fsmState === 'uploading_documents') {
    durable.currentQuestionIndex = 2; durable.answers = { q1: 'one', q2: 'two' };
  }
  const storage = {
    puts: 0, failPut: null,
    async get() { return structuredClone(durable); },
    async put(key, value) {
      this.puts++;
      if (this.failPut?.(value, this.puts)) throw new Error('Synthetic storage failure');
      durable = structuredClone(value);
    },
    async setAlarm() {},
  };
  const db = { rows: new Map(), insertAttempts: 0, failInsert: false,
    prepare(sql) {
      let values;
      return {
        bind(...args) { values = args; return this; },
        async first() { return structuredClone(config); },
        async all() { return { results: structuredClone(questions) }; },
        async run() {
          assert.match(sql, /ON CONFLICT\(id\) DO NOTHING/);
          db.insertAttempts++;
          if (db.failInsert) throw new Error('Synthetic D1 failure');
          const changed = db.rows.has(values[0]) ? 0 : 1;
          if (changed) db.rows.set(values[0], structuredClone(values));
          return { success: true, meta: { changes: changed } };
        },
      };
    },
  };
  const background = [], webhookCalls = [];
  const context = { storage, getWebSockets: () => [], waitUntil: promise => background.push(promise) };
  const makeServer = () => {
    const instance = new CheckinSession(context, { DB: db });
    instance._fireWebhook = async (id, snapshot) => { webhookCalls.push({ id, snapshot: structuredClone(snapshot) }); };
    return instance;
  };
  const ws = { sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() {} };
  let server = makeServer();
  return {
    storage, db, ws, webhookCalls, questions, config,
    get server() { return server; }, get durable() { return structuredClone(durable); },
    restart() { server = makeServer(); },
    async send(message) { await server.webSocketMessage(ws, JSON.stringify(message)); await Promise.all(background); return ws.sent; },
  };
}
const answer = (operation_id = randomUUID(), field = 'first', text = 'synthetic answer') => ({ type: 'user_transcript', operation_id, field, text });
const results = f => f.ws.sent.filter(message => message.type === 'operation_result');

test('ACK follows durable answer+receipt and precedes next question', async t => {
  const f = fixture(t); const message = answer();
  const send = f.ws.send;
  f.ws.send = function(raw) {
    if (JSON.parse(raw).type === 'operation_result') {
      assert.equal(f.durable.answers.q1, message.text);
      assert.equal(f.durable.operationReceipts[message.operation_id].result.success, true);
    }
    send.call(this, raw);
  };
  await f.send(message);
  assert.deepEqual(f.ws.sent.map(x => x.type), ['operation_result', 'state']);
  assert.equal(f.durable.currentQuestionIndex, 1);
});

test('storage failure emits negative ACK, no state event, and retry persists once', async t => {
  const f = fixture(t); const message = answer();
  f.storage.failPut = () => true;
  await f.send(message);
  assert.equal(results(f)[0].success, false);
  assert.equal(results(f)[0].retryable, true);
  assert.equal(f.ws.sent.length, 1);
  assert.deepEqual(f.durable.answers, {});
  f.storage.failPut = null; f.ws.sent = [];
  await f.send(message);
  assert.equal(results(f)[0].success, true);
  assert.equal(f.durable.currentQuestionIndex, 1);
});

test('initial storage read failure returns a correlated retryable ACK', async t => {
  const f = fixture(t); const message = answer();
  const get = f.storage.get;
  f.storage.get = async () => { throw new Error('Synthetic read failure'); };
  await f.send(message);
  assert.equal(results(f)[0].operation_id, message.operation_id);
  assert.equal(results(f)[0].success, false); assert.equal(results(f)[0].retryable, true);
  assert.equal(f.storage.puts, 0);
  f.storage.get = get; f.ws.sent = [];
  await f.send(message);
  assert.equal(results(f)[0].success, true); assert.equal(f.durable.currentQuestionIndex, 1);
});

test('concurrent duplicate operation IDs advance once', async t => {
  const f = fixture(t); const message = answer();
  await Promise.all([f.send(message), f.send(message)]);
  assert.equal(f.storage.puts, 1);
  assert.equal(f.durable.currentQuestionIndex, 1);
  assert.equal(results(f).length, 2);
  assert.ok(results(f).every(x => x.success));
  assert.equal(f.ws.sent.filter(x => x.type === 'state').length, 1);
});

test('dedupe survives a new instance and canonicalizes object key order', async t => {
  const f = fixture(t); const message = answer(); await f.send(message);
  f.restart(); f.ws.sent = [];
  await f.send({ text: message.text, field: message.field, operation_id: message.operation_id, type: message.type });
  assert.equal(f.storage.puts, 1);
  assert.equal(results(f)[0].success, true);
  assert.equal(f.durable.currentQuestionIndex, 1);
});

test('reusing ID with changed content is rejected without changing saved answer', async t => {
  const f = fixture(t); const message = answer(); await f.send(message); f.ws.sent = [];
  await f.send({ ...message, text: 'changed synthetic answer' });
  assert.equal(results(f)[0].success, false);
  assert.match(results(f)[0].error, /different content/);
  assert.equal(f.durable.answers.q1, message.text);
});

test('validation errors are explicit and their dedupe survives restart', async t => {
  const f = fixture(t); const message = answer(randomUUID(), 'missing', 'synthetic');
  await f.send(message); assert.equal(results(f)[0].success, false);
  assert.equal(results(f)[0].retryable, false);
  assert.match(results(f)[0].error, /Unknown field/);
  f.restart(); f.ws.sent = [];
  await f.send(message); assert.equal(results(f)[0].success, false);
  assert.equal(f.storage.puts, 1);
});

test('blank answers and attempts to skip to a later question return failure', async t => {
  const f = fixture(t);
  await f.send(answer(randomUUID(), 'first', '  '));
  await f.send(answer(randomUUID(), 'second', 'later'));
  assert.ok(results(f).every(x => x.success === false));
  assert.deepEqual(f.durable.answers, {});
  assert.equal(f.durable.currentQuestionIndex, 0);
});

test('correction at summary preserves position and ACK precedes refreshed summary', async t => {
  const f = fixture(t, { fsmState: 'confirming' });
  await f.send(answer(randomUUID(), 'first', 'corrected synthetic'));
  assert.equal(f.durable.answers.q1, 'corrected synthetic');
  assert.equal(f.durable.answers.q2, 'two');
  assert.equal(f.durable.currentQuestionIndex, 2);
  assert.deepEqual(f.ws.sent.map(x => x.type), ['operation_result', 'summary']);
});

test('OCR correction persists before ACK and refreshes summary', async t => {
  const f = fixture(t, { fsmState: 'confirming' });
  await f.send({ type: 'ocr_correction', operation_id: randomUUID(), field: 'name', value: 'Corrected Synthetic Visitor' });
  assert.equal(f.durable.ocrData.name, 'Corrected Synthetic Visitor');
  assert.deepEqual(f.ws.sent.map(x => x.type), ['operation_result', 'summary']);
});

test('documents_done is durable and repeat does not transition twice', async t => {
  const f = fixture(t, { fsmState: 'uploading_documents' });
  const message = { type: 'documents_done', operation_id: randomUUID() };
  await Promise.all([f.send(message), f.send(message)]);
  assert.equal(f.durable.fsmState, 'confirming');
  assert.equal(f.storage.puts, 1);
  assert.equal(f.ws.sent.filter(x => x.type === 'summary').length, 1);
});

test('concurrent confirm duplicates create one row/webhook and ACK before completion', async t => {
  const f = fixture(t, { fsmState: 'confirming' });
  const message = { type: 'confirm', operation_id: randomUUID() };
  await Promise.all([f.send(message), f.send(message)]);
  assert.equal(f.db.rows.size, 1); assert.equal(f.db.insertAttempts, 1);
  assert.equal(f.webhookCalls.length, 1);
  assert.deepEqual(f.ws.sent.map(x => x.type), ['operation_result', 'checkin_complete', 'operation_result', 'checkin_complete']);
  f.restart(); f.ws.sent = [];
  await f.send({ type: 'confirm', operation_id: randomUUID() });
  assert.equal(f.db.rows.size, 1); assert.equal(f.db.insertAttempts, 1); assert.equal(f.webhookCalls.length, 1);
  assert.equal(results(f)[0].success, true);
});

test('distinct concurrent confirm IDs still finalize one registration and webhook', async t => {
  const f = fixture(t, { fsmState: 'confirming' });
  await Promise.all([
    f.send({ type: 'confirm', operation_id: randomUUID() }),
    f.send({ type: 'confirm', operation_id: randomUUID() }),
  ]);
  assert.equal(f.db.rows.size, 1); assert.equal(f.db.insertAttempts, 1); assert.equal(f.webhookCalls.length, 1);
  assert.equal(results(f).length, 2); assert.ok(results(f).every(x => x.success));
});

test('confirmation reservation failure performs no D1 write or webhook', async t => {
  const f = fixture(t, { fsmState: 'confirming' }); f.storage.failPut = () => true;
  await f.send({ type: 'confirm', operation_id: randomUUID() });
  assert.equal(f.db.insertAttempts, 0); assert.equal(f.webhookCalls.length, 0);
  assert.equal(results(f)[0].success, false);
  assert.equal(f.ws.sent.length, 1);
});

test('D1 failure retains stable durable registration ID for retry', async t => {
  const f = fixture(t, { fsmState: 'confirming' }); const message = { type: 'confirm', operation_id: randomUUID() };
  f.db.failInsert = true; await f.send(message);
  const stableId = f.durable.pendingRegistration.id;
  assert.equal(results(f)[0].success, false); assert.equal(f.webhookCalls.length, 0);
  assert.equal(results(f)[0].retryable, true);
  f.db.failInsert = false; f.restart(); f.ws.sent = [];
  await f.send(message);
  assert.equal(f.durable.lastRegistrationId, stableId); assert.ok(f.db.rows.has(stableId));
  assert.equal(f.webhookCalls.length, 1);
});

test('successful D1 insert followed by failed session save remains idempotent after restart', async t => {
  const f = fixture(t, { fsmState: 'confirming' }); const message = { type: 'confirm', operation_id: randomUUID() };
  f.storage.failPut = value => value.fsmState === 'done';
  await f.send(message);
  assert.equal(f.db.rows.size, 1); assert.equal(f.webhookCalls.length, 0);
  assert.equal(results(f)[0].success, false);
  assert.equal(f.ws.sent.some(x => x.type === 'checkin_complete'), false);
  assert.equal(results(f)[0].retryable, true);
  const stableId = f.durable.pendingRegistration.id;
  assert.equal(f.durable.fsmState, 'confirming');
  f.restart(); f.storage.failPut = null; f.ws.sent = [];
  await f.send(message);
  assert.equal(f.db.rows.size, 1); assert.equal(f.db.insertAttempts, 2);
  assert.equal(f.durable.lastRegistrationId, stableId); assert.equal(f.webhookCalls.length, 1);
  assert.deepEqual(f.ws.sent.map(x => x.type), ['operation_result', 'checkin_complete']);
});

test('partially committed confirmation cannot change its reserved payload', async t => {
  const f = fixture(t, { fsmState: 'confirming' }); const message = { type: 'confirm', operation_id: randomUUID() };
  f.storage.failPut = value => value.fsmState === 'done'; await f.send(message);
  f.storage.failPut = null; f.ws.sent = [];
  await f.send(answer(randomUUID(), 'first', 'different answer'));
  assert.equal(results(f)[0].success, false); assert.match(results(f)[0].error, /Confirmation is pending/);
  f.ws.sent = [];
  await f.send({ ...message, unexpected: 'different payload' });
  assert.match(results(f)[0].error, /different content/);
  assert.equal(f.db.rows.size, 1);
});

test('resume restores full public state before announcing the current step', async t => {
  const f = fixture(t); await f.send(answer()); f.restart(); f.ws.sent = [];
  await f.send({ type: 'resume', business_id: 'business-one' });
  const restored = f.ws.sent[0];
  assert.equal(restored.type, 'session_restored');
  assert.equal(restored.business_id, 'business-one'); assert.equal(restored.business_name, 'Synthetic Clinic');
  assert.equal(restored.welcome_message, 'Synthetic welcome'); assert.equal(restored.voice_id, 'anna');
  assert.equal(restored.voice_persona, 'concise'); assert.equal(restored.requires_id_scan, true);
  assert.equal(restored.current_question_index, 1); assert.equal(restored.answers.q1, 'synthetic answer');
  assert.equal(restored.ocr_data.name, 'Synthetic Visitor'); assert.equal(restored.state, 'asking_questions');
  assert.deepEqual(restored.questions[0], { id: 'q1', text: 'Synthetic question one?', type: 'text', field: 'first' });
  assert.deepEqual(f.ws.sent.map(x => x.type), ['session_restored', 'state']);
  assert.equal(JSON.stringify(restored).includes('webhook'), false);
  assert.equal(JSON.stringify(restored).includes('SYNTHETIC-NOT-A-SECRET'), false);
  assert.equal('operationReceipts' in restored, false);
});

test('business mismatch resume reveals no state, and legacy resume still works', async t => {
  const f = fixture(t);
  await f.send({ type: 'resume', business_id: 'business-two' });
  assert.deepEqual(f.ws.sent, [{ type: 'error', message: 'Session belongs to a different business' }]);
  f.ws.sent = []; await f.send({ type: 'resume' });
  assert.equal(f.ws.sent[0].type, 'session_restored');
});

test('legacy answers and confirmation remain usable without operation ACKs', async t => {
  const f = fixture(t);
  await f.send({ type: 'user_transcript', text: 'legacy one' });
  await f.send({ type: 'user_transcript', text: 'legacy two' });
  await f.send({ type: 'confirm' });
  assert.equal(f.db.rows.size, 1); assert.equal(results(f).length, 0);
  assert.equal(f.durable.fsmState, 'done');
});

test('invalid UUID is rejected before mutation', async t => {
  const f = fixture(t); await f.send(answer('__proto__'));
  assert.equal(results(f)[0].success, false); assert.equal(f.storage.puts, 0);
  assert.deepEqual(f.durable.answers, {});
});

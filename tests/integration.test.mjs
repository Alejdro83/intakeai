import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CheckinSession } from '../api/checkin-do.js';
import { createClientHarness, settle } from './client-harness.mjs';

// Real client + real Durable Object class + actual SQLite schema/SQL. Only the
// browser, network, DO storage API and D1 adapter are simulated. No remote calls.
async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO businesses(id,name,business_type,requires_id_scan) VALUES(?,?,?,?)')
    .run('synthetic-business', 'Synthetic reception', 'office', 0);
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO business_questions(id,business_id,field_key,question_text,order_index) VALUES(?,?,?,?,?)')
    .run(`q${i}`, 'synthetic-business', `field${i}`, `Synthetic question ${i}?`, i);
  const storageData = new Map();
  const storage = {
    async get(key) { return structuredClone(storageData.get(key)); },
    async put(key, value) { storageData.set(key, structuredClone(value)); },
    async setAlarm() {},
  };
  const background = [], pending = [];
  let failInsert = false, dropResponses = false;
  const d1 = { prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        if (failInsert && sql.includes('INSERT INTO guest_registrations')) throw new Error('Synthetic D1 outage');
        const result = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  } };
  const server = new CheckinSession({storage, getWebSockets:()=>[], waitUntil:p=>background.push(p)}, {DB:d1});
  let h = await createClientHarness();
  t.after(async () => { await h.dispose(); db.close(); });
  const received = [];
  const attach = async () => {
    h.app.state.businessId = 'synthetic-business';
    h.app.state.aaiWs = h.socket('wss://synthetic-voice.invalid');
    h.app.state.aaiReady = true;
    h.app.initEventListeners();
    await h.app.connectToDO();
    const doSocket = h.app.state.doWs;
    const serverSocket = {
      send(raw) {
        const message = JSON.parse(raw);
        received.push(message);
        if (!dropResponses) doSocket.receive(message);
      },
      close() {},
    };
    const recordSend = doSocket.send.bind(doSocket);
    doSocket.send = raw => {
      recordSend(raw);
      pending.push(server.webSocketMessage(serverSocket, raw));
    };
    doSocket.open();
  };
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    await Promise.all(background);
    await settle();
  };
  await attach(); await drain();
  return {
    db, received, get h(){return h;}, storageData,
    set dropResponses(value){dropResponses=value;}, set failInsert(value){failInsert=value;},
    drain,
    async answer(index, value = `synthetic answer ${index}`, callId = `synthetic-call-${index}`) {
      h.app.handleAAILogic({type:'reply.started'});
      const result = h.app.queueToolResult({name:'submit_answer',call_id:callId,arguments:{field:`field${index}`,answer:value}});
      h.app.handleAAILogic({type:'reply.done',status:'completed'});
      await drain(); await result;
    },
    async confirm() {
      const click = h.app.elements.btnConfirmSummary.click();
      await drain(); await click;
    },
    async reload() {
      const storage = h.storage;
      await h.dispose();
      h = await createClientHarness({storage});
      await attach(); await drain();
    },
  };
}

test('five answers, correction and manual confirmation persist the exact SQLite record', async t => {
  const f = await fixture(t);
  for (let i=0;i<5;i++) await f.answer(i);
  await f.answer(1, 'corrected synthetic answer', 'synthetic-correction');
  await f.confirm();
  const rows=f.db.prepare('SELECT * FROM guest_registrations').all();
  assert.equal(rows.length,1);
  assert.equal(JSON.parse(rows[0].answers_json).q1,'corrected synthetic answer');
  assert.equal(Object.keys(JSON.parse(rows[0].answers_json)).length,5);
  assert.equal(f.h.app.state.checkinDone,true);
  assert.equal(f.h.app.elements.confirmMessage.textContent,'Your check-in is complete!');
  assert.equal(f.h.storage.getItem(f.h.app.SESSION_STORAGE_KEY),null);
  assert.equal(f.h.requests.length,0);
});

test('lost confirmation ACK then retry returns the existing SQLite row', async t => {
  const f = await fixture(t);
  for (let i=0;i<5;i++) await f.answer(i);
  f.dropResponses=true;
  const firstClick=f.h.app.elements.btnConfirmSummary.click();
  await f.drain(); await f.h.tick(10000); await firstClick;
  const firstId=f.h.app.state.manualConfirmOperationId;
  assert.equal(f.h.app.elements.btnConfirmSummary.disabled,false);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM guest_registrations').get().count,1);
  f.dropResponses=false;
  await f.confirm();
  assert.equal(f.h.app.state.manualConfirmOperationId,firstId);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM guest_registrations').get().count,1);
  assert.equal(f.h.app.state.checkinDone,true);
});

test('D1 failure is shown without claiming completion; retry succeeds once', async t => {
  const f = await fixture(t);
  for (let i=0;i<5;i++) await f.answer(i);
  f.failInsert=true; await f.confirm();
  const operationId=f.h.app.state.manualConfirmOperationId;
  assert.equal(f.h.app.state.checkinDone,false);
  assert.equal(f.h.app.elements.btnConfirmSummary.disabled,false);
  assert.match(f.h.app.elements.statusText.textContent,/retry/i);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM guest_registrations').get().count,0);
  f.failInsert=false; await f.confirm();
  assert.equal(f.h.app.state.manualConfirmOperationId,operationId);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM guest_registrations').get().count,1);
  assert.equal(f.h.app.state.checkinDone,true);
});

test('page reload restores three saved answers and finishes the remaining two', async t => {
  const f = await fixture(t);
  for (let i=0;i<3;i++) await f.answer(i);
  const sessionId=f.h.app.state.sessionId;
  await f.reload();
  assert.equal(f.h.app.state.sessionId,sessionId);
  assert.equal(f.h.app.state.currentQuestionIndex,3);
  assert.equal(Object.keys(f.h.app.state.answers).length,3);
  assert.match(f.h.app.buildInterviewPrompt(),/next question number 4/);
  await f.answer(3); await f.answer(4); await f.confirm();
  const row=f.db.prepare('SELECT * FROM guest_registrations').get();
  assert.equal(Object.keys(JSON.parse(row.answers_json)).length,5);
  assert.equal(f.h.app.state.checkinDone,true);
});

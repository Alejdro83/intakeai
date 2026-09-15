# Offline regression tests

Use Node 24 or later. The suite uses only built-in Node modules; there is no
dependency installation, browser extension, microphone, external service or
production database involved.

```sh
node --test tests/*.test.mjs
```

`npm test` is an equivalent shortcut. Do not run an install command for these
tests. `integration.test.mjs` uses Node's built-in SQLite module and the actual
`schema.sql` in an in-memory database.

## Coverage

- `audio.test.mjs`: activation and permission errors, total timeout, abort,
  partial setup cleanup and microphone streams granted after cancellation.
- `client-audio.test.mjs`: token/worklet/backend connection timeouts and late
  callbacks from an abandoned voice connection.
- `client.test.mjs`: operation acknowledgements, duplicate tool calls, reply
  ordering, interrupted replies, cleanup, confirmation/document button
  recovery, business-scoped session references, resume snapshots and a single
  scan-to-interview handoff.
- `server.test.mjs`: persisted operation receipts, serialized mutations,
  duplicate/concurrent requests, validation, storage/D1 failures, confirmation
  recovery and backward-compatible messages.
- `integration.test.mjs`: the real client and Durable Object class connected by
  an in-memory transport, executing actual SQLite SQL. Five answers, correction,
  confirmation, lost-ACK retry, database failure/retry and page reload recovery
  must produce the expected stored registration.

The client is imported as a native ES module with `DOMContentLoaded` held back
by the harness. Tests use the exported functions the browser actually runs;
there is no copied replacement implementation or dynamic code evaluator.

## Application protocol

New clients send a UUID `operation_id` with `user_transcript`, `ocr_correction`,
`documents_done` and `confirm`. The server returns:

```json
{"type":"operation_result","operation_id":"00000000-0000-4000-8000-000000000001","success":true}
```

The success response is sent only after durable storage and before the UI state
events. Failures include `error`; `retryable:true` means a transient storage/D1
failure. A timeout or a lost connection leaves the result unconfirmed. A retry
must retain its operation ID rather than guessing whether the earlier write
committed. A definitive validation failure requires correcting the request.

Receipts bind the operation ID to the request content, persist with the session
and survive a new Durable Object instance. The session retains up to 500
receipts without evicting old IDs. Confirmations reserve a stable registration
ID before inserting into D1, so a failed session save after a successful INSERT
does not create a second registration on retry. This needs no schema migration.

`resume` includes `business_id`. The server checks it and emits a
`session_restored` snapshot containing public business settings, questions,
saved answers, OCR, phase and question index before the current screen event.
Session references in the browser expire after ten minutes and are scoped to
the business; no visitor answers or document data are stored in sessionStorage.

AssemblyAI tool results still respect the documented `reply.done` ordering:
https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference

## Rollout and limits

Deploy the backend before the updated static client. The server accepts the
older messages without operation IDs; the new client requires acknowledgement
support. Keep `app.js`, `audio-lifecycle.js` and the `type="module"` script tag
in `index.html` together when publishing the static site. To roll back, restore
the old static client first, then the old backend. An open old tab remains
compatible with the new backend.

The tests do not certify Cloudflare's runtime, real microphone permission UI,
recognition accuracy, model behavior, speech synthesis, network latency, OCR or
delivery of a webhook. Webhooks remain best effort: a durable scheduling marker
prevents normal replay from scheduling twice, but a crash between that marker
and the request can lose delivery. Exactly-once external delivery would require
an outbox and an idempotent receiver.

A slow OCR response no longer pretends the server has moved to the interview:
the UI stays on the scan step with a waiting message until the server responds.
There is no new text-only questionnaire or OCR cancellation endpoint in this PR.

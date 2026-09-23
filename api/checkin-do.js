/**
 * CheckinSession — Durable Object for Virtualobby visitor check-in.
 *
 * FSM: idle → greeting → scanning_doc → asking_questions → confirming → done
 *
 * Env bindings: env.DB (D1), env.R2_DOCS (R2), env.AI (Workers AI)
 */

async function computeHmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const OPERATION_TYPES = new Set(["user_transcript", "ocr_correction", "confirm", "documents_done"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_OPERATIONS = 500;
class OperationError extends Error {}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function operationFingerprint(data) {
  const { operation_id, ...payload } = data;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class CheckinSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = null; // loaded async in fetch(), on the WS upgrade
    this.messageQueue = Promise.resolve();
    this.outbound = null;
    this.afterCommit = [];
  }

  _freshSession() {
    return {
      businessId: null,
      fsmState: "idle",
      businessConfig: null,
      questions: [],
      currentQuestionIndex: 0,
      answers: {},
      ocrData: null,
      idImageR2Key: null,
      startedAt: null,
      operationReceipts: {},
      pendingRegistration: null,
    };
  }

  async _loadSession() {
    if (this.session) return;
    this.session = (await this.state.storage.get("session")) || this._freshSession();
  }

  async _saveSession() {
    await this.state.storage.put("session", this.session);
  }

  _serialize(work) {
    const result = this.messageQueue.then(work);
    this.messageQueue = result.catch(() => {});
    return result;
  }

  _send(ws, obj) {
    if (this.outbound) {
      this.outbound.push({ ws, obj: structuredClone(obj) });
      return;
    }
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  _error(ws, message) {
    if (this.outbound) throw new OperationError(message);
    this._send(ws, { type: "error", message });
  }

  async fetch(request) {
    return this._serialize(() => this._fetch(request));
  }

  async _fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      // Confirmed bug (external review, 2026-09): this used to live in a
      // webSocketOpen(ws) method, which looks like it should be part of the
      // Hibernation WebSocket API but isn't — Cloudflare's docs only define
      // webSocketMessage/webSocketClose/webSocketError, so that method was
      // simply never called. The alarm that's supposed to wipe an
      // abandoned session after 10 minutes never got scheduled, ever.
      await this._loadSession();
      this.session.startedAt = Date.now();
      await this._saveSession();
      try { await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000); } catch (_) {}
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "PUT") {
      try { return await this._handleUploadRequest(request); } catch (_) {
        this.session = null;
        return new Response(JSON.stringify({ error: "Failed to save upload state; please retry" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  /**
   * Receives a file directly (PUT /api/ws/<uuid>) — either the ID photo
   * while scanning_doc, or one of the optional additional documents while
   * uploading_documents. Only accepted in those two states — that's what
   * stops it from being an open write proxy into R2 for anyone who finds
   * the URL.
   */
  async _handleUploadRequest(request) {
    await this._loadSession();
    const fsmState = this.session.fsmState;
    if (fsmState !== "scanning_doc" && fsmState !== "uploading_documents") {
      return new Response(
        JSON.stringify({ error: "Not expecting an upload right now (state=" + fsmState + ")" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    const isIdScan = fsmState === "scanning_doc";
    const contentType = request.headers.get("Content-Type") || (isIdScan ? "image/jpeg" : "application/octet-stream");
    const key = isIdScan
      ? `ids/${this.session.businessId || "unknown"}/${crypto.randomUUID()}.jpg`
      : `docs/${this.session.businessId || "unknown"}/${crypto.randomUUID()}`;
    try {
      await this.env.R2_DOCS.put(key, request.body, { httpMetadata: { contentType } });
    } catch (err) {
      return new Response(JSON.stringify({ error: `Upload failed: ${err.message}` }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    if (!isIdScan) {
      this.session.additionalDocs = this.session.additionalDocs || [];
      this.session.additionalDocs.push({ r2_key: key, content_type: contentType });
    } else {
      // Confirmed bug (external review, 2026-09): _handleIdUploaded used to
      // trust whatever r2_key the client sent in its next WS message with
      // no check at all — checking fsmState only proves this session is
      // AT the scanning step, not that the key it names was ever issued to
      // it. Recording the one real key this upload just created, and
      // requiring an exact match later, closes that.
      this.session.pendingIdUpload = key;
    }
    await this._saveSession();
    return new Response(JSON.stringify({ ok: true, r2_key: key }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async webSocketMessage(ws, message) {
    return this._serialize(() => this._processMessage(ws, message));
  }

  async _processMessage(ws, message) {
    let data, fingerprint, operationId;
    try {
      try { data = JSON.parse(message); } catch { return this._error(ws, "Invalid JSON"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return this._error(ws, "Invalid message");
      if (OPERATION_TYPES.has(data.type) && data.operation_id !== undefined) {
        operationId = data.operation_id;
        if (typeof operationId !== "string" || !UUID_PATTERN.test(operationId)) {
          return this._send(ws, { type: "operation_result", operation_id: operationId, success: false, error: "operation_id must be a UUID" });
        }
        fingerprint = await operationFingerprint(data);
      }
      // Parse the operation identity before accessing storage so even a
      // failed initial read can return a correlated, retryable negative ACK.
      await this._loadSession();
      if (operationId) {
        const reservation = this.session.pendingRegistration;
        if (reservation?.operationId === operationId && reservation.fingerprint !== fingerprint) {
          return this._send(ws, { type: "operation_result", operation_id: operationId, success: false, error: "operation_id was already used with different content" });
        }
        const receipts = this.session.operationReceipts || {};
        const previous = receipts[operationId];
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            return this._send(ws, { type: "operation_result", operation_id: operationId, success: false, error: "operation_id was already used with different content" });
          }
          this._send(ws, previous.result);
          if (data.type === "confirm" && previous.result.success && this.session.lastRegistrationId) {
            this._send(ws, { type: "checkin_complete", registration_id: this.session.lastRegistrationId });
          }
          return;
        }
        if (Object.keys(receipts).length >= MAX_SESSION_OPERATIONS) {
          return this._send(ws, { type: "operation_result", operation_id: operationId, success: false, error: "Session operation limit reached" });
        }
      }

      // Buffer UI events until both the mutation and its dedupe receipt are durable.
      // The ACK must precede checkin_complete, which tears down the voice client.
      this.outbound = [];
      this.afterCommit = [];
      this.activeOperation = operationId ? { operationId, fingerprint } : null;
      switch (data.type) {
        case "start": await this._handleStart(ws, data); break;
        case "user_transcript": await this._handleTranscript(ws, data); break;
        case "id_uploaded": await this._handleIdUploaded(ws, data); break;
        case "ocr_correction": await this._handleOcrCorrection(ws, data); break;
        case "confirm": await this._handleConfirm(ws); break;
        case "documents_done": await this._handleDocumentsDone(ws); break;
        case "resume": await this._handleResume(ws, data); break;
        default: this._error(ws, `Unknown message type: ${data.type}`);
      }
      const result = operationId ? { type: "operation_result", operation_id: operationId, success: true } : null;
      if (result) {
        this.session.operationReceipts ||= {};
        this.session.operationReceipts[operationId] = { fingerprint, result };
      }
      await this._saveSession();
      const events = this.outbound, afterCommit = this.afterCommit;
      this.outbound = null; this.afterCommit = []; this.activeOperation = null;
      if (result) this._send(ws, result);
      for (const event of events) this._send(event.ws, event.obj);
      for (const run of afterCommit) {
        try { run(); } catch (_) { console.error("Post-commit task could not be scheduled"); }
      }
    } catch (err) {
      this.outbound = null; this.afterCommit = []; this.activeOperation = null;
      // A failed write must not remain visible in memory on the next message.
      // Reload also preserves a confirm checkpoint made before a D1 insertion.
      this.session = null;
      const error = err instanceof OperationError ? err.message : "Failed to save operation; retry with the same operation_id";
      if (operationId && fingerprint) {
        const result = { type: "operation_result", operation_id: operationId, success: false, error, retryable: !(err instanceof OperationError) };
        if (err instanceof OperationError) {
          try {
            await this._loadSession();
            this.session.operationReceipts ||= {};
            this.session.operationReceipts[operationId] = { fingerprint, result };
            await this._saveSession();
          } catch (_) { this.session = null; }
        }
        this._send(ws, result);
      } else {
        this._error(ws, error);
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    console.log("WebSocket closed:", code, reason || "");
  }

  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }

  async alarm() {
    return this._serialize(() => this._expireSession());
  }

  async _expireSession() {
    for (const ws of this.state.getWebSockets()) {
      this._send(ws, { type: "error", message: "Session timed out" });
      try { ws.close(); } catch (_) {}
    }
    this.session = this._freshSession();
    await this._saveSession();
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: start → greeting                                             */
  /* ------------------------------------------------------------------ */

  async _handleStart(ws, data) {
    const businessId = data.business_id;
    if (!businessId) return this._error(ws, "Missing business_id");
    if (this.session.businessId) return this._handleResume(ws, data);

    this.session.businessId = businessId;

    try {
      const biz = await this.env.DB.prepare("SELECT * FROM businesses WHERE id = ?").bind(businessId).first();
      if (!biz) return this._error(ws, "Business not found");
      this.session.businessConfig = biz;

      const { results } = await this.env.DB.prepare(
        "SELECT * FROM business_questions WHERE business_id = ? ORDER BY order_index ASC"
      ).bind(businessId).all();
      this.session.questions = results || [];
    } catch (err) {
      return this._error(ws, `DB error: ${err.message}`);
    }

    const bizName = this.session.businessConfig?.name || "our office";
    const requiresScan = this.session.businessConfig?.requires_id_scan;

    this._send(ws, {
      type: "welcome",
      // The configured welcome_message was previously stored but never sent
      // anywhere — the browser only ever heard a hardcoded "Welcome to X!"
      // regardless of what was actually set up for the business.
      welcome_message: this.session.businessConfig?.welcome_message || `Welcome to ${bizName}!`,
      business_name: bizName,
      business_type: this.session.businessConfig?.business_type || "",
      voice_id: this.session.businessConfig?.voice_id || "anna",
      voice_persona: this.session.businessConfig?.voice_persona || "",
      questions: this.session.questions.map(q => ({
        id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key,
      })),
      requires_id_scan: requiresScan,
      // The agent's system prompt needs to know a documents step is coming
      // BEFORE the interview starts — otherwise it has no way to avoid
      // summarizing right after the last question, ahead of that step.
      requires_documents: !!this.session.businessConfig?.requires_documents,
      documents_prompt: this.session.businessConfig?.documents_prompt || "",
    });

    if (requiresScan) {
      this.session.fsmState = "scanning_doc";
      this._send(ws, { type: "request_camera", text: "Please scan your ID document" });
    } else {
      this.session.fsmState = "asking_questions";
      // No questions_ready here: that message means "a scan attempt just
      // finished" and makes the client run its post-scan interview handoff
      // (which assumes OCR was attempted and apologizes if it found nothing).
      // With scanning disabled there was never a scan to report on — the
      // welcome message already gave the client everything it needs, and
      // connectToAssemblyAI() goes straight into the interview prompt.
      this._sendCurrentQuestion(ws);
    }

  }

  /**
   * Re-announces wherever the FSM already is, for a client that reconnected
   * (e.g. after a dropped WebSocket) to the same session URL — never resets
   * progress the way re-sending "start" would (it forces fsmState back to
   * scanning_doc/asking_questions unconditionally, which would re-request a
   * scan or a question the visitor already got past).
   */
  async _handleResume(ws, data = {}) {
    if (!this.session.businessId) {
      return this._error(ws, "No active session to resume");
    }
    if (data.business_id !== undefined && data.business_id !== this.session.businessId) {
      return this._error(ws, "Session belongs to a different business");
    }
    const config = this.session.businessConfig || {};
    const businessName = config.name || "our office";
    this._send(ws, {
      type: "session_restored",
      business_id: this.session.businessId,
      business_name: businessName,
      business_type: config.business_type || "",
      welcome_message: config.welcome_message || `Welcome to ${businessName}!`,
      voice_id: config.voice_id || "anna",
      voice_persona: config.voice_persona || "",
      requires_id_scan: !!config.requires_id_scan,
      requires_documents: !!config.requires_documents,
      documents_prompt: config.documents_prompt || "",
      questions: this.session.questions.map(q => ({ id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key })),
      answers: this.session.answers || {},
      ocr_data: this.session.ocrData || {},
      current_question_index: this.session.currentQuestionIndex,
      state: this.session.fsmState,
    });
    switch (this.session.fsmState) {
      case "scanning_doc":
        this._send(ws, { type: "request_camera", text: "Please scan your ID document" });
        break;
      case "asking_questions":
        this._sendCurrentQuestion(ws);
        break;
      case "uploading_documents":
        this._goToUploadingDocuments(ws);
        break;
      case "confirming":
        this._goToConfirming(ws);
        break;
      case "done":
        this._send(ws, { type: "checkin_complete", registration_id: this.session.lastRegistrationId || null });
        break;
      default: {
        const bizName = this.session.businessConfig?.name || "our office";
        this._send(ws, {
          type: "welcome",
          welcome_message: this.session.businessConfig?.welcome_message || `Welcome to ${bizName}!`,
          business_name: bizName,
          business_type: this.session.businessConfig?.business_type || "",
          voice_id: this.session.businessConfig?.voice_id || "anna",
          voice_persona: this.session.businessConfig?.voice_persona || "",
          questions: this.session.questions.map(q => ({
            id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key,
          })),
          requires_id_scan: this.session.businessConfig?.requires_id_scan,
          requires_documents: !!this.session.businessConfig?.requires_documents,
          documents_prompt: this.session.businessConfig?.documents_prompt || "",
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: scanning_doc → upload received                               */
  /* ------------------------------------------------------------------ */

  async _handleIdUploaded(ws, data) {
    console.log("_handleIdUploaded: fsmState=" + this.session.fsmState);
    if (this.session.fsmState !== "scanning_doc") {
      return this._error(ws, "Not expecting document upload (state=" + this.session.fsmState + ")");
    }

    const r2Key = data.r2_key;
    if (!r2Key) return this._error(ws, "Missing r2_key");
    if (r2Key !== this.session.pendingIdUpload) {
      return this._error(ws, "r2_key was not issued to this session");
    }
    this.session.pendingIdUpload = null;

    this.session.idImageR2Key = r2Key;

    let fields = {};
    let success = false;
    try {
      fields = await this._runOcr(r2Key);
      success = Object.keys(fields).length > 0;
    } catch (err) {
      console.error("OCR failed:", err);
    }
    this.session.ocrData = fields;

    this._send(ws, { type: "ocr_result", fields, success });
    this.session.fsmState = "asking_questions";
    this._sendQuestionsReady(ws);
    this._sendCurrentQuestion(ws);
  }

  /**
   * The voice agent calls this (via the correct_ocr_field tool, forwarded
   * by the browser) whenever the visitor corrects a piece of scanned ID
   * data verbally. Without this, a spoken correction only ever lived in the
   * LLM's own conversation memory — the agent would say it back correctly,
   * but the stored ocrData (and so the final D1 record and any on-screen
   * summary) stayed on the original, possibly-wrong OCR value forever.
   */
  async _handleOcrCorrection(ws, data) {
    if (!["asking_questions", "uploading_documents", "confirming"].includes(this.session.fsmState)) {
      return this._error(ws, "Not accepting OCR corrections in this state");
    }
    if (this.session.pendingRegistration) return this._error(ws, "Confirmation is pending; retry confirmation");
    const { field, value } = data;
    const allowed = ["name", "id_number", "date_of_birth", "address"];
    if (!allowed.includes(field) || typeof value !== "string" || !value.trim()) {
      return this._error(ws, "Invalid ocr_correction: field must be one of " + allowed.join(", ") + " with a non-empty value");
    }
    // Confirmed bug (external review, 2026-09): this logged the actual
    // corrected value (a real date of birth, address, etc.) — with Workers
    // Logs enabled, that's PII landing in a persistent log store. Log which
    // field changed, never the value itself.
    console.log("_handleOcrCorrection: " + field + " updated");
    this.session.ocrData = { ...(this.session.ocrData || {}), [field]: value.trim() };
    if (this.session.fsmState === "confirming") this._goToConfirming(ws);
  }

  /**
   * Runs the ID photo through Workers AI vision to pull structured fields.
   * https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
   */
  async _runOcr(r2Key) {
    const obj = await this.env.R2_DOCS.get(r2Key);
    if (!obj) throw new Error("Image not found in R2: " + r2Key);
    const bytes = new Uint8Array(await obj.arrayBuffer());

    const prompt =
      "You are looking at a photo of an identity document (ID card, passport, or driver's " +
      "license). Extract these fields if they are visible: full name, id_number (the " +
      "document/ID number), date_of_birth (YYYY-MM-DD if you can tell), address. " +
      "Reply with ONLY a compact JSON object and nothing else — no prose, no markdown " +
      'fences — using exactly these keys: {"name": "", "id_number": "", "date_of_birth": "", ' +
      '"address": ""}. Use an empty string for any field you cannot read.';

    const result = await this.env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: Array.from(bytes),
      prompt,
      // A live test against this model returned the full 4-field JSON in
      // ~42 completion tokens; 200 leaves comfortable headroom for a long
      // name/address while cutting the generation budget from the original
      // 512 — a small but real latency win on top of the client-side resize.
      max_tokens: 200,
    });

    const raw = (result && (result.response || result.description || result.result || result.text)) || "";
    // Workers AI sometimes auto-parses a JSON-shaped model reply into an
    // object (result.response comes back as {name: ..., ...} directly)
    // instead of the raw string the prompt asked for — pick fields straight
    // off it in that case rather than stringifying and re-parsing.
    if (raw && typeof raw === "object") return this._pickOcrFields(raw);
    return this._parseOcrJson(raw);
  }

  _pickOcrFields(parsed) {
    const out = {};
    for (const key of ["name", "id_number", "date_of_birth", "address"]) {
      if (parsed[key]) out[key] = String(parsed[key]).trim();
    }
    return out;
  }

  _parseOcrJson(raw) {
    if (!raw) return {};
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) text = braceMatch[0];
    try {
      const parsed = JSON.parse(text);
      return this._pickOcrFields(parsed);
    } catch (err) {
      // Confirmed bug (external review, 2026-09): logged the raw model
      // output, which is the visitor's actual extracted ID data (name, DOB,
      // ID number) straight from the vision model — real PII, not just a
      // debugging string. Log the failure and its length, never the text.
      console.error("Failed to parse OCR JSON:", err.message, "raw length:", text.length);
      return {};
    }
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: asking_questions                                             */
  /* ------------------------------------------------------------------ */

  _sendQuestionsReady(ws) {
    this._send(ws, {
      type: "questions_ready",
      questions: this.session.questions.map(q => ({
        id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key,
      })),
      ocr_data: this.session.ocrData || {},
      business_name: this.session.businessConfig?.name || "our office",
    });
  }

  _sendCurrentQuestion(ws) {
    const { questions, currentQuestionIndex } = this.session;
    if (currentQuestionIndex >= questions.length) {
      return this._finishQuestions(ws);
    }
    const q = questions[currentQuestionIndex];
    this._send(ws, {
      type: "state",
      state: "asking_questions",
      question: q.question_text,
      index: currentQuestionIndex,
      total: questions.length,
    });
  }

  // Confirmed bug (external review, 2026-09): this always wrote to
  // questions[currentQuestionIndex] and always advanced, no matter why the
  // message was sent. The system prompt told the agent to "correct" an
  // earlier answer by calling submit_answer again — but that just landed in
  // whatever slot came next, silently shifting every answer after it, and
  // during "confirming" this whole block was skipped, so a correction
  // spoken at the summary was dropped without a trace. The client now sends
  // an explicit `field`, so the DO can target the right question directly
  // instead of assuming "whichever one is next."
  async _handleTranscript(ws, data) {
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return this._error(ws, "Answer must be a non-empty string");
    // Also allowed during uploading_documents: a visitor can still ask to
    // fix an earlier numbered answer while on the (optional) attachments
    // step, before ever reaching the summary.
    const correctable = ["asking_questions", "uploading_documents", "confirming"];
    if (!correctable.includes(this.session.fsmState)) return this._error(ws, "Not accepting answers in this state");
    if (this.session.pendingRegistration) return this._error(ws, "Confirmation is pending; retry confirmation");

    const questions = this.session.questions;
    const currentQ = questions[this.session.currentQuestionIndex]; // undefined once all are answered
    const field = data.field;

    let targetQ;
    if (field) {
      targetQ = questions.find((q) => q.field_key === field);
      if (!targetQ) return this._error(ws, `Unknown field: ${field}`);
    } else {
      // No field given (older client, or a stray message) — only safe to
      // guess "the current one", and only while still mid-sequence.
      targetQ = currentQ;
    }
    if (!targetQ) return this._error(ws, "No question to answer");
    if (this.session.fsmState === "asking_questions" && questions.indexOf(targetQ) > this.session.currentQuestionIndex) {
      return this._error(ws, "Answer the current question before a later question");
    }

    this.session.answers[targetQ.field_key] = text;

    const isSequentialAdvance = this.session.fsmState === "asking_questions" && currentQ && targetQ === currentQ;
    if (isSequentialAdvance) {
      this.session.currentQuestionIndex++;
      this._sendCurrentQuestion(ws);
    } else if (this.session.fsmState === "confirming") {
      // A correction spoken after the summary — re-send it with the fix applied.
      this._goToConfirming(ws);
    }
    // Otherwise: a correction to an earlier question while still mid-sequence.
    // The answer is updated in place; the current question position is
    // untouched, so there's nothing to re-send.
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: asking_questions → uploading_documents (optional) → confirming */
  /* ------------------------------------------------------------------ */

  // All numbered questions are answered — either go straight to confirming
  // (the common case) or, for business types like clinics/law firms that
  // need more than the ID, stop for an optional attachment step first.
  _finishQuestions(ws) {
    if (this.session.businessConfig?.requires_documents) {
      return this._goToUploadingDocuments(ws);
    }
    return this._goToConfirming(ws);
  }

  _goToUploadingDocuments(ws) {
    this.session.fsmState = "uploading_documents";
    this._send(ws, {
      type: "request_documents",
      prompt: this.session.businessConfig?.documents_prompt ||
        "Please upload any additional documents, or continue if you have none.",
    });
  }

  // The visitor tapped Continue on the documents step — whether or not they
  // actually uploaded anything, this always advances (never blocks on it).
  async _handleDocumentsDone(ws) {
    if (this.session.fsmState !== "uploading_documents") {
      return this._error(ws, "Not expecting documents_done (state=" + this.session.fsmState + ")");
    }
    this._goToConfirming(ws);
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: confirming → done                                            */
  /* ------------------------------------------------------------------ */

  _goToConfirming(ws) {
    this.session.fsmState = "confirming";
    this._send(ws, {
      type: "summary",
      answers: this.session.answers,
      ocr: this.session.ocrData || {},
    });
  }

  async _handleConfirm(ws) {
    if (this.session.fsmState === "done" && this.session.lastRegistrationId) {
      this._send(ws, { type: "checkin_complete", registration_id: this.session.lastRegistrationId });
      return;
    }
    if (this.session.fsmState !== "confirming") {
      return this._error(ws, "Not ready for confirmation");
    }
    // D1 and DO storage are separate stores. Reserve the identity AND payload
    // durably before inserting, so a retry after a partial commit uses the same
    // primary key and the exact same submitted answers.
    if (!this.session.pendingRegistration) {
      this.session.pendingRegistration = {
        id: crypto.randomUUID(),
        ...(this.activeOperation || {}),
        businessId: this.session.businessId,
        answersJson: JSON.stringify(this.session.answers),
        ocrJson: JSON.stringify(this.session.ocrData || {}),
        idImageR2Key: this.session.idImageR2Key || null,
        documentsJson: JSON.stringify(this.session.additionalDocs || []),
      };
      await this._saveSession();
    }
    const registration = this.session.pendingRegistration;
    const result = await this.env.DB.prepare(
      `INSERT INTO guest_registrations (id, business_id, answers_json, ocr_data_json, id_image_r2_key, documents_json, status) VALUES (?, ?, ?, ?, ?, ?, 'completed') ON CONFLICT(id) DO NOTHING`
    ).bind(registration.id, registration.businessId, registration.answersJson, registration.ocrJson,
      registration.idImageR2Key, registration.documentsJson).run();
    if (result?.success === false) throw new Error("Registration insert failed");

    this.session.fsmState = "done";
    this.session.lastRegistrationId = registration.id;
    this._send(ws, { type: "checkin_complete", registration_id: registration.id });
    if (!this.session.webhookClaimed) {
      this.session.webhookClaimed = true;
      const deliverySession = structuredClone(this.session);
      // The claim and completion are committed before dispatch. Normal replay
      // never sends twice. This is best-effort delivery, not an atomic outbox:
      // a process loss between the durable claim and fetch can lose delivery.
      this.afterCommit.push(() => this.state.waitUntil(this._fireWebhook(registration.id, deliverySession)));
    }
    this.afterCommit.push(() => setTimeout(() => { try { ws.close(); } catch (_) {} }, 2000));
  }

  async _fireWebhook(registrationId, session = this.session) {
    const url = session.businessConfig?.webhook_url;
    if (!url) return;

    const payload = {
      event: "checkin.completed",
      business_id: session.businessId,
      business_name: session.businessConfig?.name || "",
      registration_id: registrationId,
      created_at: new Date().toISOString(),
      answers: session.answers,
      ocr_data: session.ocrData || null,
    };
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };

    const secret = session.businessConfig?.webhook_secret;
    if (secret) {
      headers["X-Virtualobby-Signature"] = `sha256=${await computeHmacSha256Hex(secret, body)}`;
    }

    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        console.error(`Webhook delivery failed for business ${session.businessId}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`Webhook delivery error for business ${session.businessId}: ${err.message}`);
    }
  }
}

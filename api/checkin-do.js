/**
 * CheckinSession — Durable Object for Virtualobby visitor check-in.
 *
 * FSM: idle → greeting → scanning_doc → asking_questions → confirming → done
 *
 * Env bindings: env.DB (D1), env.R2_DOCS (R2), env.AI (Workers AI)
 */

export class CheckinSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = null; // loaded async in webSocketOpen
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
    };
  }

  async _loadSession() {
    if (this.session) return;
    this.session = (await this.state.storage.get("session")) || this._freshSession();
  }

  async _saveSession() {
    try { await this.state.storage.put("session", this.session); } catch (e) {
      console.error("Failed to save session:", e);
    }
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  _error(ws, message) {
    this._send(ws, { type: "error", message });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "PUT") {
      return this._handleUploadRequest(request);
    }
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  /**
   * Receives the ID photo directly (PUT /api/ws/<uuid>). Only accepted while
   * this visitor's own session is waiting for a scan — that's what stops it
   * from being an open write proxy into R2 for anyone who finds the URL.
   */
  async _handleUploadRequest(request) {
    await this._loadSession();
    if (this.session.fsmState !== "scanning_doc") {
      return new Response(
        JSON.stringify({ error: "Not expecting a document upload right now (state=" + this.session.fsmState + ")" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    const contentType = request.headers.get("Content-Type") || "image/jpeg";
    const key = `ids/${this.session.businessId || "unknown"}/${crypto.randomUUID()}.jpg`;
    try {
      await this.env.R2_DOCS.put(key, request.body, { httpMetadata: { contentType } });
    } catch (err) {
      return new Response(JSON.stringify({ error: `Upload failed: ${err.message}` }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, r2_key: key }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async webSocketOpen(ws) {
    await this._loadSession();
    this.session.startedAt = Date.now();
    await this._saveSession();
    try { await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000); } catch (_) {}
  }

  async webSocketMessage(ws, message) {
    try {
      await this._loadSession();
      let data;
      try { data = JSON.parse(message); } catch { return this._error(ws, "Invalid JSON"); }

      switch (data.type) {
        case "start": return await this._handleStart(ws, data);
        case "user_transcript": return await this._handleTranscript(ws, data);
        case "id_uploaded": return await this._handleIdUploaded(ws, data);
        case "confirm": return await this._handleConfirm(ws);
        default: return this._error(ws, `Unknown message type: ${data.type}`);
      }
    } catch (err) {
      console.error("webSocketMessage FATAL:", err);
      this._error(ws, "Internal error: " + err.message);
    }
  }

  async webSocketClose(ws, code, reason) {
    console.log("WebSocket closed:", code, reason || "");
  }

  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }

  async alarm() {
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
      text: `Welcome to ${bizName}!`,
      business_name: bizName,
      voice_persona: this.session.businessConfig?.voice_persona || "anna",
      questions: this.session.questions.map(q => ({
        id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key,
      })),
      requires_id_scan: requiresScan,
    });

    if (requiresScan) {
      this.session.fsmState = "scanning_doc";
      this._send(ws, { type: "request_camera", text: "Please scan your ID document" });
    } else {
      this.session.fsmState = "asking_questions";
      this._sendQuestionsReady(ws);
      this._sendCurrentQuestion(ws);
    }

    await this._saveSession();
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
    await this._saveSession();
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
      max_tokens: 512,
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
      console.error("Failed to parse OCR JSON:", err, "raw:", text);
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
      return this._goToConfirming(ws);
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

  async _handleTranscript(ws, data) {
    const text = (data.text || "").trim();
    if (!text) return;

    if (this.session.fsmState === "asking_questions") {
      const q = this.session.questions[this.session.currentQuestionIndex];
      this.session.answers[q.id || `q${this.session.currentQuestionIndex}`] = text;
      this.session.currentQuestionIndex++;
      this._sendCurrentQuestion(ws);
      await this._saveSession();
    }
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
    if (this.session.fsmState !== "confirming") {
      return this._error(ws, "Not ready for confirmation");
    }

    const registrationId = crypto.randomUUID();

    try {
      await this.env.DB.prepare(
        `INSERT INTO guest_registrations (id, business_id, answers_json, ocr_data_json, id_image_r2_key, status) VALUES (?, ?, ?, ?, ?, 'completed')`
      ).bind(
        registrationId,
        this.session.businessId,
        JSON.stringify(this.session.answers),
        JSON.stringify(this.session.ocrData || {}),
        this.session.idImageR2Key || null
      ).run();
    } catch (err) {
      return this._error(ws, `Failed to save registration: ${err.message}`);
    }

    this.session.fsmState = "done";
    this._send(ws, { type: "checkin_complete", registration_id: registrationId });
    await this._saveSession();

    setTimeout(() => { try { ws.close(); } catch (_) {} }, 2000);
  }
}

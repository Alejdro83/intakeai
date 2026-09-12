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
    this.session = this._freshSession();
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
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  async webSocketOpen(ws) {
    this.session.startedAt = Date.now();
    try { await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000); } catch (_) {}
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return this._error(ws, "Invalid JSON"); }

    switch (data.type) {
      case "start": return this._handleStart(ws, data);
      case "user_transcript": return this._handleTranscript(ws, data);
      case "id_uploaded": return this._handleIdUploaded(ws, data);
      case "confirm": return this._handleConfirm(ws);
      default: return this._error(ws, `Unknown message type: ${data.type}`);
    }
  }

  async webSocketClose() {}
  async webSocketError(ws, error) { console.error("WebSocket error:", error); }

  async alarm() {
    for (const ws of this.state.getWebSockets()) {
      this._send(ws, { type: "error", message: "Session timed out" });
      try { ws.close(); } catch (_) {}
    }
    this.session = this._freshSession();
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: start → greeting + request camera                            */
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

    const bizName = this.session.businessConfig.name || "our office";
    const requiresScan = this.session.businessConfig.requires_id_scan;

    // Send welcome
    this._send(ws, {
      type: "welcome",
      text: `Welcome to ${bizName}!`,
      business_name: bizName,
      voice_persona: this.session.businessConfig.voice_persona || "anna",
      questions: this.session.questions.map(q => ({
        id: q.id, text: q.question_text, type: q.validation_type, field: q.field_key,
      })),
      requires_id_scan: requiresScan,
    });

    if (requiresScan) {
      // ID scan first → camera before voice
      this.session.fsmState = "scanning_doc";
      this._send(ws, {
        type: "request_camera",
        text: "Please scan your ID document",
      });
    } else {
      // No scan → straight to questions with voice
      this.session.fsmState = "asking_questions";
      this._sendQuestionsReady(ws);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: scanning_doc → OCR                                           */
  /* ------------------------------------------------------------------ */

  async _handleIdUploaded(ws, data) {
    if (this.session.fsmState !== "scanning_doc") {
      return this._error(ws, "Not expecting document upload");
    }

    const r2Key = data.r2_key;
    if (!r2Key) return this._error(ws, "Missing r2_key");

    this.session.idImageR2Key = r2Key;

    // Attempt OCR — if anything fails, continue WITHOUT OCR (non-fatal)
    let ocrOk = false;
    if (this.env.AI) {
      try {
        const obj = await this.env.R2_DOCS.get(r2Key);
        if (obj) {
          const arrayBuffer = await obj.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

          const result = await this.env.AI.run("@cf/meta/llama-3.2-11b-vision", {
            image: base64,
            prompt:
              "Extract the following fields from this document in JSON format: " +
              '{"name": "", "id_number": "", "date_of_birth": "", "address": ""}. ' +
              "Return only valid JSON, no explanation.",
          });

          const text = typeof result === "string" ? result : result?.response || "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            this.session.ocrData = JSON.parse(jsonMatch[0]);
            ocrOk = true;
          }
        } else {
          console.error("R2 object not found:", r2Key);
        }
      } catch (err) {
        console.error("OCR error (non-fatal):", err);
      }
    }

    // Send OCR result (even if empty — frontend shows what was extracted)
    this._send(ws, {
      type: "ocr_result",
      fields: this.session.ocrData || {},
      success: ocrOk,
    });

    // Always continue to questions — never get stuck
    this.session.fsmState = "asking_questions";
    this._sendQuestionsReady(ws);
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

    setTimeout(() => { try { ws.close(); } catch (_) {} }, 2000);
  }
}

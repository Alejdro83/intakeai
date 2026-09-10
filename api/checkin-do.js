/**
 * CheckinSession — Durable Object for Virtualobby visitor check-in.
 *
 * Each visitor gets their own DO instance (UUID-keyed by the Worker).
 * The browser connects via WebSocket, sends "start" with a business_id,
 * and the DO walks the visitor through an FSM-driven questionnaire,
 * optional ID scan (R2 + Vision OCR), and final confirmation.
 *
 * FSM: idle → greeting → asking_questions → scanning_doc → confirming → done
 *
 * Env bindings expected:
 *   env.DB       — D1Database
 *   env.R2_DOCS  — R2Bucket
 *   env.AI       — Workers AI (optional, for vision OCR)
 */

export class CheckinSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = this._freshSession();
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

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
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {
      /* peer already closed */
    }
  }

  _error(ws, message) {
    this._send(ws, { type: "error", message });
  }

  /* ------------------------------------------------------------------ */
  /*  fetch() — accept WebSocket upgrade                                 */
  /* ------------------------------------------------------------------ */

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade — accept via Hibernation API
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  /* ------------------------------------------------------------------ */
  /*  WebSocket Hibernation handlers                                     */
  /* ------------------------------------------------------------------ */

  async webSocketOpen(ws) {
    // Session starts; alarm will handle timeout.
    this.session.startedAt = Date.now();
    try {
      await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    } catch (_) {
      /* alarm may already be set */
    }
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return this._error(ws, "Invalid JSON");
    }

    switch (data.type) {
      case "start":
        return this._handleStart(ws, data);
      case "user_transcript":
        return this._handleTranscript(ws, data);
      case "id_uploaded":
        return this._handleIdUploaded(ws, data);
      case "confirm":
        return this._handleConfirm(ws);
      default:
        return this._error(ws, `Unknown message type: ${data.type}`);
    }
  }

  async webSocketClose(ws) {
    // Nothing to persist — ephemeral session.
  }

  async webSocketError(ws, error) {
    console.error("WebSocket error:", error);
  }

  /* ------------------------------------------------------------------ */
  /*  Alarm — 10-minute session timeout                                  */
  /* ------------------------------------------------------------------ */

  async alarm() {
    const websockets = this.state.getWebSockets();
    for (const ws of websockets) {
      this._send(ws, { type: "error", message: "Session timed out" });
      try { ws.close(); } catch (_) {}
    }
    this.session = this._freshSession();
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: start                                                         */
  /* ------------------------------------------------------------------ */

  async _handleStart(ws, data) {
    const businessId = data.business_id;
    if (!businessId) return this._error(ws, "Missing business_id");

    this.session.businessId = businessId;

    // Load business config from D1
    try {
      const biz = await this.env.DB.prepare(
        "SELECT * FROM businesses WHERE id = ?"
      ).bind(businessId).first();

      if (!biz) return this._error(ws, "Business not found");
      this.session.businessConfig = biz;

      // Load questions
      const { results } = await this.env.DB.prepare(
        "SELECT * FROM business_questions WHERE business_id = ? ORDER BY order_index ASC"
      ).bind(businessId).all();

      this.session.questions = results || [];
    } catch (err) {
      return this._error(ws, `DB error: ${err.message}`);
    }

    // Move to greeting
    this.session.fsmState = "greeting";
    const greetingText = `Welcome to ${this.session.businessConfig.name || "our office"}!`;

    this._send(ws, {
      type: "welcome",
      text: greetingText,
      voice_persona: this.session.businessConfig.voice_persona || "anna",
    });

    // Immediately transition to first question (or scanning if none)
    this.session.fsmState = "asking_questions";
    this._sendCurrentQuestion(ws);
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: asking_questions                                              */
  /* ------------------------------------------------------------------ */

  _sendCurrentQuestion(ws) {
    const { questions, currentQuestionIndex } = this.session;

    if (currentQuestionIndex >= questions.length) {
      // All questions answered — move to doc scanning if business requires it
      if (this.session.businessConfig.requires_id_scan) {
        this.session.fsmState = "scanning_doc";
        return this._send(ws, {
          type: "request_camera",
          text: "Please show your document to the camera",
        });
      }
      // Skip to confirmation
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
      // Store answer
      const q = this.session.questions[this.session.currentQuestionIndex];
      this.session.answers[q.id || `q${this.session.currentQuestionIndex}`] = text;
      this.session.currentQuestionIndex++;
      this._sendCurrentQuestion(ws);
    }
    // In other states, transcript is ignored (browser handles voice locally)
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: scanning_doc → OCR via R2 + Vision                           */
  /* ------------------------------------------------------------------ */

  async _handleIdUploaded(ws, data) {
    if (this.session.fsmState !== "scanning_doc") {
      return this._error(ws, "Not expecting document upload");
    }

    const r2Key = data.r2_key;
    if (!r2Key) return this._error(ws, "Missing r2_key");

    this.session.idImageR2Key = r2Key;

    // Attempt OCR if Workers AI binding exists
    if (this.env.AI) {
      try {
        const obj = await this.env.R2_DOCS.get(r2Key);
        if (!obj) return this._error(ws, "Image not found in storage");

        const arrayBuffer = await obj.arrayBuffer();
        const base64 = btoa(
          String.fromCharCode(...new Uint8Array(arrayBuffer))
        );

        const result = await this.env.AI.run(
          "@cf/meta/llama-3.2-11b-vision",
          {
            image: base64,
            prompt:
              "Extract the following fields from this document in JSON format: " +
              '{"name": "", "id_number": "", "date_of_birth": "", "address": ""}. ' +
              "Return only valid JSON, no explanation.",
          }
        );

        // Parse the AI response — try to extract JSON from the text
        const text =
          typeof result === "string" ? result : result?.response || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          this.session.ocrData = JSON.parse(jsonMatch[0]);
        }
      } catch (err) {
        console.error("OCR error:", err);
        // Non-fatal — continue without OCR data
      }
    }

    // Send OCR result (or empty if AI not available)
    this._send(ws, {
      type: "ocr_result",
      fields: this.session.ocrData || {},
    });

    this._goToConfirming(ws);
  }

  /* ------------------------------------------------------------------ */
  /*  FSM: confirming → done                                             */
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
        `INSERT INTO guest_registrations
           (id, business_id, answers_json, ocr_data_json, id_image_r2_key, status)
         VALUES (?, ?, ?, ?, ?, 'completed')`
      )
        .bind(
          registrationId,
          this.session.businessId,
          JSON.stringify(this.session.answers),
          JSON.stringify(this.session.ocrData || {}),
          this.session.idImageR2Key || null
        )
        .run();
    } catch (err) {
      return this._error(ws, `Failed to save registration: ${err.message}`);
    }

    this.session.fsmState = "done";
    this._send(ws, {
      type: "checkin_complete",
      registration_id: registrationId,
    });

    // Close session after a short delay
    setTimeout(() => {
      try { ws.close(); } catch (_) {}
    }, 2000);
  }
}

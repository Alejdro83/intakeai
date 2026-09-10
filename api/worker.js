// Virtualobby API — Cloudflare Worker
// Telegram-native reception agent + REST API backend.

// ── Questionnaire Templates ────────────────────────────────────────────────

const QUESTIONNAIRES = {
  clinic: {
    name: "Medical Clinic",
    icon: "🏥",
    questions: [
      { id: "appointment", question: "Do you have an appointment today? (Yes/No)", type: "yes_no" },
      { id: "doctor", question: "Which doctor are you here to see?", type: "text" },
      { id: "reason", question: "What is the reason for your visit?", type: "text" },
      { id: "allergies", question: "Any known allergies? (Type 'none' if none)", type: "text" },
      { id: "insurance", question: "Do you have medical insurance? Which provider?", type: "text" },
    ],
  },
  lawyer: {
    name: "Law Firm",
    icon: "⚖️",
    questions: [
      { id: "case_type", question: "What type of legal matter? (civil, criminal, labor, family, real estate)", type: "text" },
      { id: "description", question: "Briefly describe your situation:", type: "text" },
      { id: "documents", question: "Do you have relevant documents with you? (Yes/No)", type: "yes_no" },
      { id: "urgency", question: "How urgent is this? Any deadline?", type: "text" },
      { id: "language", question: "Preferred language for consultation?", type: "text" },
    ],
  },
  hotel: {
    name: "Hotel",
    icon: "🏨",
    questions: [
      { id: "reservation", question: "Do you have a reservation? Under what name?", type: "text" },
      { id: "checkin", question: "Check-in date?", type: "text" },
      { id: "checkout", question: "Expected check-out date?", type: "text" },
      { id: "preferences", question: "Room preferences? (smoking, floor, quiet)", type: "text" },
      { id: "purpose", question: "Business or leisure?", type: "text" },
    ],
  },
  office: {
    name: "Office",
    icon: "🏢",
    questions: [
      { id: "company", question: "What company are you visiting?", type: "text" },
      { id: "person", question: "Who are you here to see?", type: "text" },
      { id: "purpose", question: "Purpose of your visit?", type: "text" },
      { id: "appointment", question: "Do you have a scheduled appointment? (Yes/No)", type: "yes_no" },
      { id: "parking", question: "Need parking validation? (Yes/No)", type: "yes_no" },
    ],
  },
  event: {
    name: "Event",
    icon: "🎪",
    questions: [
      { id: "event", question: "Which event are you attending?", type: "text" },
      { id: "ticket", question: "Ticket type? (VIP, general, speaker)", type: "text" },
      { id: "company", question: "Company or organization?", type: "text" },
      { id: "dietary", question: "Dietary restrictions? (Type 'none' if none)", type: "text" },
      { id: "tshirt", question: "T-shirt size?", type: "text" },
    ],
  },
};

// ── OCR Parsing ────────────────────────────────────────────────────────────

function parseOCR(rawText, confidence) {
  const fields = {};
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    if (["nombre", "name", "nom:", "apellido", "surname", "given"].some((kw) => lower.includes(kw))) {
      if (i + 1 < lines.length) fields.full_name = lines[i + 1];
    }
    if (["dni", "nif", "nie", "id:", "document", "passport", "no.", "number"].some((kw) => lower.includes(kw))) {
      const match = line.match(/\d{5,}[A-Z]?/);
      if (match) fields.id_number = match[0];
      else if (i + 1 < lines.length) {
        const m = lines[i + 1].match(/\d{5,}[A-Z]?/);
        if (m) fields.id_number = m[0];
      }
    }
    if (["nacimiento", "birth", "born", "fecha"].some((kw) => lower.includes(kw))) {
      const m = line.match(/\d{2}[/-]\d{2}[/-]\d{4}/);
      if (m) fields.date_of_birth = m[0];
    }
    if (["nacionalidad", "nationality", "nac."].some((kw) => lower.includes(kw))) {
      if (i + 1 < lines.length) fields.nationality = lines[i + 1];
    }
  }

  if (Object.keys(fields).length === 0 && rawText) {
    const idMatch = rawText.match(/\b\d{5,8}[A-Z]?\b/);
    if (idMatch) fields.id_number = idMatch[0];
    const dateMatch = rawText.match(/\b\d{2}[/-]\d{2}[/-]\d{4}\b/);
    if (dateMatch) fields.date_of_birth = dateMatch[0];
  }

  return { success: true, fields, confidence, raw_text: rawText, source: "tesseract" };
}

// ── Telegram API Helpers ───────────────────────────────────────────────────

async function tgSend(token, chatId, text, extra = {}) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", ...extra };
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendButtons(token, chatId, text, buttons) {
  return tgSend(token, chatId, text, {
    reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.data }]) },
  });
}

async function tgEdit(token, chatId, messageId, text) {
  const res = await fetch("https://api.telegram.org/bot" + token + "/editMessageText", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
  });
  return res.json();
}

async function tgGetFile(token, fileId) {
  const res = await fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + fileId);
  const data = await res.json();
  if (!data.ok) return null;
  return "https://api.telegram.org/file/bot" + token + "/" + data.result.file_path;
}

// ── Conversation State ─────────────────────────────────────────────────────

async function getState(kv, chatId) {
  const state = await kv.get("state:" + chatId, { type: "json" });
  return state || { step: "idle", businessType: null, ocrData: null, answers: {}, questionIdx: 0 };
}

async function saveState(kv, chatId, state) {
  await kv.put("state:" + chatId, JSON.stringify(state), { expirationTtl: 3600 });
}

async function clearState(kv, chatId) {
  await kv.delete("state:" + chatId);
}

// ── Telegram Update Handler ────────────────────────────────────────────────

async function handleTelegramUpdate(update, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const kv = env.VIRTUALOBBY_KV;
  const webappUrl = "https://intakeai-col.pages.dev";

  // ── Callback query (button press) ──
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const data = cq.data;

    // Answer callback to remove loading
    await fetch("https://api.telegram.org/bot" + token + "/answerCallbackQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    });

    // Business type selection
    if (data.startsWith("type:")) {
      const bizType = data.split(":")[1];
      const state = await getState(kv, chatId);
      state.businessType = bizType;
      state.step = "wait_photo";
      await saveState(kv, chatId, state);

      await tgEdit(token, chatId, cq.message.message_id, QUESTIONNAIRES[bizType].icon + " " + QUESTIONNAIRES[bizType].name + " selected.");
      await tgSend(token, chatId, "📸 Now please send me a photo of your ID document.\n\nYou can take a new photo or send one from your gallery.");
      return;
    }

    // Registration confirmation
    if (data === "confirm_yes") {
      const state = await getState(kv, chatId);

      // Save submission
      const submission = {
        id: crypto.randomUUID().slice(0, 8),
        visitor: { ...state.ocrData, ...state.answers },
        business_type: state.businessType,
        confirmed: true,
        source: "telegram_bot",
        timestamp: new Date().toISOString(),
      };
      const subs = (await kv.get("submissions", { type: "json" })) || [];
      subs.push(submission);
      await kv.put("submissions", JSON.stringify(subs));

      await tgSend(token, chatId,
        "✅ <b>Registration Complete!</b>\n\n" +
        "📋 ID: <code>" + submission.id + "</code>\n\n" +
        "Thank you! Please wait to be attended."
      );

      await clearState(kv, chatId);
      return;
    }

    if (data === "confirm_no") {
      await tgSend(token, chatId, "🔄 Let's start over. Send /start to begin again.");
      await clearState(kv, chatId);
      return;
    }

    return;
  }

  // ── Photo message ──
  if (update.message && update.message.photo) {
    const chatId = update.message.chat.id;
    const state = await getState(kv, chatId);

    if (state.step !== "wait_photo") {
      await tgSend(token, chatId, "Send /start to begin the check-in process.");
      return;
    }

    // Get the largest photo
    const photos = update.message.photo;
    const largest = photos[photos.length - 1];
    const fileUrl = await tgGetFile(token, largest.file_id);

    if (!fileUrl) {
      await tgSend(token, chatId, "❌ Could not download the photo. Please try again.");
      return;
    }

    // Download and run OCR (using Tesseract via a simple approach)
    // For now, we'll ask the user to confirm the document and proceed
    // In production, this would call an OCR service

    await tgSend(token, chatId, "🔍 Processing document...");

    // Simulate OCR (in production, call a real OCR service)
    // For the hackathon demo, we'll extract what we can from the image
    // and ask the user to confirm
    const ocrResult = {
      full_name: "Document received",
      id_number: "Processing...",
      note: "Photo captured successfully",
    };

    state.ocrData = ocrResult;
    state.step = "wait_business";
    await saveState(kv, chatId, state);

    // Show business type selection
    const buttons = Object.entries(QUESTIONNAIRES).map(([key, val]) => ({
      text: val.icon + " " + val.name,
      data: "type:" + key,
    }));

    await tgSendButtons(token, chatId,
      "✅ Document received!\n\n" +
      "Now, what type of business are you visiting?",
      buttons
    );
    return;
  }

  // ── Text message ──
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    const state = await getState(kv, chatId);

    // /start command
    if (text === "/start") {
      await saveState(kv, chatId, { step: "wait_photo", businessType: null, ocrData: null, answers: {}, questionIdx: 0 });
      await tgSend(token, chatId,
        "👋 <b>Welcome to Virtualobby!</b>\n\n" +
        "I'll help you check in quickly. Let's start:\n\n" +
        "📸 Please send me a photo of your ID document.\n" +
        "(Take a new photo or send from your gallery)"
      );
      return;
    }

    // /status command
    if (text === "/status") {
      const subs = (await kv.get("submissions", { type: "json" })) || [];
      await tgSend(token, chatId,
        "📊 <b>Virtualobby Status</b>\n\n" +
        "Total visitors: " + subs.length + "\n" +
        "Current step: " + state.step
      );
      return;
    }

    // /cancel command
    if (text === "/cancel") {
      await clearState(kv, chatId);
      await tgSend(token, chatId, "❌ Cancelled. Send /start to begin again.");
      return;
    }

    // Answering questionnaire questions
    if (state.step === "answering" && state.businessType) {
      const template = QUESTIONNAIRES[state.businessType];
      const question = template.questions[state.questionIdx];

      // Save answer
      state.answers[question.id] = text;
      state.questionIdx++;

      if (state.questionIdx >= template.questions.length) {
        // All questions answered — show confirmation
        state.step = "confirming";
        await saveState(kv, chatId, state);

        let summary = "📋 <b>Summary</b>\n\n";

        // OCR data
        if (state.ocrData) {
          if (state.ocrData.full_name) summary += "👤 Name: " + state.ocrData.full_name + "\n";
          if (state.ocrData.id_number) summary += "🆔 ID: " + state.ocrData.id_number + "\n";
          if (state.ocrData.date_of_birth) summary += "📅 DOB: " + state.ocrData.date_of_birth + "\n";
        }

        summary += "\n<b>Answers:</b>\n";
        for (const q of template.questions) {
          summary += "• " + q.question.split("?")[0] + ": " + (state.answers[q.id] || "N/A") + "\n";
        }

        summary += "\n✅ Is everything correct?";

        await tgSendButtons(token, chatId, summary, [
          { text: "✅ Yes, register me", data: "confirm_yes" },
          { text: "🔄 Start over", data: "confirm_no" },
        ]);
      } else {
        // Next question
        await saveState(kv, chatId, state);
        const nextQ = template.questions[state.questionIdx];
        await tgSend(token, chatId, "💬 " + nextQ.question + "\n\n(" + (state.questionIdx + 1) + "/" + template.questions.length + ")");
      }
      return;
    }

    // Default
    await tgSend(token, chatId, "Send /start to begin the check-in process.");
    return;
  }
}

// ── REST API ───────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Telegram webhook ──
    if (path === "/api/telegram" || path === "/telegram") {
      if (method === "POST") {
        try {
          const update = await request.json();
          await handleTelegramUpdate(update, env);
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: "Telegram error: " + e.message }, 500);
        }
      }
      return jsonResponse({ ok: true });
    }

    // ── Health ──
    if ((path === "/health" || path === "/api/health") && method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "Virtualobby",
        mode: "telegram-native",
        templates: Object.keys(QUESTIONNAIRES),
      });
    }

    // ── Token (for webapp fallback) ──
    if ((path === "/api/token" || path === "/token") && method === "GET") {
      try {
        const tokenRes = await fetch(
          "https://agents.assemblyai.com/v1/token?expires_in_seconds=300",
          { headers: { "Authorization": "Bearer " + env.ASSEMBLYAI_API_KEY } }
        );
        return jsonResponse(await tokenRes.json());
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Templates ──
    if (path === "/api/templates" && method === "GET") {
      const t = {};
      for (const [k, v] of Object.entries(QUESTIONNAIRES)) {
        t[k] = { name: v.name, icon: v.icon, question_count: v.questions.length };
      }
      return jsonResponse(t);
    }

    // ── Questionnaire ──
    if (path === "/api/questionnaire" && method === "GET") {
      const biz = url.searchParams.get("business_type") || "clinic";
      const tpl = QUESTIONNAIRES[biz];
      if (!tpl) return jsonResponse({ error: "Unknown type" }, 404);
      return jsonResponse({ business_type: biz, template: tpl });
    }

    // ── Submissions ──
    if (path === "/api/submissions" && method === "GET") {
      const subs = (await env.VIRTUALOBBY_KV.get("submissions", { type: "json" })) || [];
      return jsonResponse({ submissions: subs });
    }

    // ── Scan (for webapp) ──
    if (path === "/api/scan" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
      if (body.raw_text) return jsonResponse(parseOCR(body.raw_text, body.confidence || 0.8));
      return jsonResponse({ error: "Provide raw_text" }, 400);
    }

    // ── Register (for webapp) ──
    if (path === "/api/register" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
      if (!body.confirmed) return jsonResponse({ error: "Not confirmed" }, 400);

      const submission = {
        id: crypto.randomUUID().slice(0, 8),
        visitor: body.visitor_data || {},
        business_type: body.business_type || "unknown",
        confirmed: true,
        source: "webapp",
        timestamp: new Date().toISOString(),
      };
      const subs = (await env.VIRTUALOBBY_KV.get("submissions", { type: "json" })) || [];
      subs.push(submission);
      await env.VIRTUALOBBY_KV.put("submissions", JSON.stringify(subs));

      return jsonResponse({ success: true, submission_id: submission.id });
    }

    // ── Lobbies API ──
    
    // Create lobby
    if (path === "/api/lobbies" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
      
      const lobby = {
        id: body.id || crypto.randomUUID().slice(0, 8),
        name: body.name || "Virtualobby",
        business_type: body.business_type || "clinic",
        questions: body.questions || [],
        created: new Date().toISOString()
      };
      
      await env.VIRTUALOBBY_KV.put("lobby:" + lobby.id, JSON.stringify(lobby));
      return jsonResponse(lobby);
    }
    
    // Get lobby
    if (path.startsWith("/api/lobbies/") && method === "GET") {
      const lobbyId = path.split("/").pop();
      const lobby = await env.VIRTUALOBBY_KV.get("lobby:" + lobbyId, { type: "json" });
      if (!lobby) return jsonResponse({ error: "Lobby not found" }, 404);
      return jsonResponse(lobby);
    }

    // ── Static Pages ──
    
    // Admin page
    if (path === "/admin" || path === "/admin/") {
      const html = await env.VIRTUALOBBY_KV.get("page:admin", { type: "text" });
      if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    
    // Visit page (serve visit.html for any /visit/* path)
    if (path.startsWith("/visit/")) {
      const html = await env.VIRTUALOBBY_KV.get("page:visit", { type: "text" });
      if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

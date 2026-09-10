// Virtualobby API — Cloudflare Worker
// Handles document scanning, questionnaire management, visitor registration,
// and mints temporary tokens for AssemblyAI Voice Agent.

// ── Questionnaire Templates ────────────────────────────────────────────────

const QUESTIONNAIRES = {
  clinic: {
    name: "Medical Clinic",
    icon: "🏥",
    questions: [
      { id: "appointment", question: "Do you have an appointment today?", type: "yes_no" },
      { id: "doctor", question: "Which doctor are you here to see?", type: "text" },
      { id: "reason", question: "What is the reason for your visit today?", type: "text" },
      { id: "allergies", question: "Do you have any known allergies?", type: "text" },
      { id: "medication", question: "Are you currently taking any medication?", type: "text" },
      { id: "insurance", question: "Do you have medical insurance? If yes, which provider?", type: "text" },
    ],
  },
  lawyer: {
    name: "Law Firm",
    icon: "⚖️",
    questions: [
      { id: "case_type", question: "What type of legal matter do you need help with?", type: "text" },
      { id: "description", question: "Could you briefly describe your situation?", type: "text" },
      { id: "documents", question: "Do you have any relevant documents with you?", type: "yes_no" },
      { id: "previous_lawyer", question: "Have you consulted with another lawyer about this matter before?", type: "yes_no" },
      { id: "urgency", question: "How urgent is this matter?", type: "text" },
      { id: "preferred_language", question: "What language would you prefer for your consultation?", type: "text" },
    ],
  },
  hotel: {
    name: "Hotel",
    icon: "🏨",
    questions: [
      { id: "reservation", question: "Do you have a reservation?", type: "text" },
      { id: "check_in_date", question: "What is your check-in date?", type: "text" },
      { id: "check_out_date", question: "What is your expected check-out date?", type: "text" },
      { id: "room_preference", question: "Do you have any room preferences?", type: "text" },
      { id: "special_requests", question: "Do you have any special requests?", type: "text" },
      { id: "purpose", question: "What brings you here? Business or leisure?", type: "text" },
    ],
  },
  office: {
    name: "Office Reception",
    icon: "🏢",
    questions: [
      { id: "company", question: "What company are you visiting?", type: "text" },
      { id: "contact_person", question: "Who are you here to see?", type: "text" },
      { id: "department", question: "Which department?", type: "text" },
      { id: "purpose", question: "What is the purpose of your visit?", type: "text" },
      { id: "has_appointment", question: "Do you have a scheduled appointment?", type: "yes_no" },
      { id: "parking", question: "Did you need parking validation?", type: "yes_no" },
    ],
  },
  event: {
    name: "Event Registration",
    icon: "🎪",
    questions: [
      { id: "event_name", question: "Which event are you attending?", type: "text" },
      { id: "ticket_type", question: "What type of ticket do you have?", type: "text" },
      { id: "company", question: "What company or organization are you with?", type: "text" },
      { id: "dietary", question: "Do you have any dietary restrictions?", type: "text" },
      { id: "tshirt_size", question: "What t-shirt size would you like?", type: "text" },
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

    if (["nombre", "name", "nom:", "apellido"].some((kw) => lower.includes(kw))) {
      if (i + 1 < lines.length) fields.full_name = lines[i + 1];
    }

    if (["dni", "nif", "nie", "id:", "document", "passport", "no."].some((kw) => lower.includes(kw))) {
      const match = line.match(/\d{5,}[A-Z]?/);
      if (match) fields.id_number = match[0];
      else if (i + 1 < lines.length) {
        const nextMatch = lines[i + 1].match(/\d{5,}[A-Z]?/);
        if (nextMatch) fields.id_number = nextMatch[0];
      }
    }

    if (["nacimiento", "birth", "born", "fecha"].some((kw) => lower.includes(kw))) {
      const dateMatch = line.match(/\d{2}[/-]\d{2}[/-]\d{4}/);
      if (dateMatch) fields.date_of_birth = dateMatch[0];
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

  return {
    success: true,
    fields,
    document_type: "ID Card",
    confidence,
    raw_text: rawText,
    source: "browser_tesseract",
  };
}

// ── CORS Headers ───────────────────────────────────────────────────────────

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

// ── Worker Handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET endpoints ──────────────────────────────────────────────

    if (method === "GET") {
      // Health
      if (path === "/health" || path === "/api/health") {
        return jsonResponse({
          status: "ok",
          service: "Virtualobby",
          templates: Object.keys(QUESTIONNAIRES),
          assemblyai_configured: !!env.ASSEMBLYAI_API_KEY,
        });
      }

      // Templates
      if (path === "/api/templates") {
        const templates = {};
        for (const [key, val] of Object.entries(QUESTIONNAIRES)) {
          templates[key] = {
            name: val.name,
            icon: val.icon,
            question_count: val.questions.length,
          };
        }
        return jsonResponse(templates);
      }

      // Questionnaire
      if (path === "/api/questionnaire") {
        const businessType = url.searchParams.get("business_type") || "clinic";
        const template = QUESTIONNAIRES[businessType];
        if (!template) {
          return jsonResponse({ error: `Unknown business type: ${businessType}` }, 404);
        }
        return jsonResponse({ business_type: businessType, template });
      }

      // Submissions (from KV)
      if (path === "/api/submissions") {
        const subs = await env.VIRTUALOBBY_KV.get("submissions", { type: "json" });
        return jsonResponse({ submissions: subs || [] });
      }

      // Token endpoint — mint temporary token for Voice Agent
      if (path === "/api/token" || path === "/token") {
        try {
          const tokenRes = await fetch(
            "https://agents.assemblyai.com/v1/token?expires_in_seconds=300&max_session_duration_seconds=3600",
            {
              headers: {
                "Authorization": "Bearer " + env.ASSEMBLYAI_API_KEY,
              },
            }
          );
          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            return jsonResponse({ error: "Token request failed: " + errText }, 502);
          }
          const tokenData = await tokenRes.json();
          return jsonResponse(tokenData);
        } catch (e) {
          return jsonResponse({ error: "Token error: " + e.message }, 500);
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    // ── POST endpoints ─────────────────────────────────────────────

    if (method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      // Document scan
      if (path === "/api/scan") {
        if (body.raw_text) {
          const result = parseOCR(body.raw_text, body.confidence || 0.8);
          return jsonResponse(result);
        }
        if (body.image_data) {
          return jsonResponse({
            success: false,
            error: "Image OCR not yet available. Use browser Tesseract.js instead.",
            fields: {},
          });
        }
        return jsonResponse({ error: "Provide raw_text or image_data" }, 400);
      }

      // Register visitor
      if (path === "/api/register") {
        if (!body.confirmed) {
          return jsonResponse({ error: "Visitor must confirm data before registration" }, 400);
        }

        const submission = {
          id: crypto.randomUUID().slice(0, 8),
          visitor: body.visitor_data || {},
          business_type: body.business_type || "unknown",
          confirmed: true,
          source: "voice_agent",
          timestamp: new Date().toISOString(),
        };

        // Save to KV
        const subs = (await env.VIRTUALOBBY_KV.get("submissions", { type: "json" })) || [];
        subs.push(submission);
        await env.VIRTUALOBBY_KV.put("submissions", JSON.stringify(subs));

        return jsonResponse({
          success: true,
          submission_id: submission.id,
          message: "Visitor registered successfully. ID: " + submission.id,
        });
      }

      // Telegram webhook
      if (path === "/api/telegram" || path === "/telegram") {
        try {
          const update = body;
          
          // Handle /start command
          if (update.message && update.message.text === "/start") {
            const chatId = update.message.chat.id;
            const webappUrl = "https://intakeai-col.pages.dev";
            
            await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: "Welcome to Virtualobby! 🏥\n\nI'll help you check in quickly using voice and document scanning.\n\nTap the button below to start:",
                reply_markup: {
                  inline_keyboard: [[{
                    text: "📋 Open Virtualobby",
                    web_app: { url: webappUrl }
                  }]]
                }
              })
            });
            
            return jsonResponse({ ok: true });
          }
          
          return jsonResponse({ ok: true });
        } catch (e) {
          return jsonResponse({ error: "Telegram error: " + e.message }, 500);
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  },
};

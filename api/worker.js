// Virtualobby API — Cloudflare Worker
// Voice-powered reception agent: D1-backed businesses, R2 uploads, AssemblyAI proxy.

import { CheckinSession } from './checkin-do.js';

// ── CORS ──────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Telegram Helpers ──────────────────────────────────────────────────────

async function tgSend(token, chatId, text, extra = {}) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function handleTelegramUpdate(update, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const webappUrl = 'https://intakeai-col.pages.dev';

  if (update.message && update.message.text === '/start') {
    const chatId = update.message.chat.id;
    await tgSend(token, chatId, '👋 <b>Welcome to Virtualobby!</b>\n\nTap below to open the check-in app.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Open Virtualobby', web_app: { url: webappUrl } }]],
      },
    });
  }

  return { ok: true };
}

// ── URL Router ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── CORS preflight ──
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Telegram webhook ──
    if (path === '/api/telegram' && method === 'POST') {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: 'Telegram error: ' + e.message }, 500);
      }
    }

    // ── Health ──
    if (path === '/api/health' && method === 'GET') {
      return jsonResponse({ status: 'ok', service: 'Virtualobby' });
    }

    // ── AssemblyAI session token ──
    if (path === '/api/token' && method === 'GET') {
      try {
        const resp = await fetch(
          'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60',
          { headers: { Authorization: `Bearer ${env.ASSEMBLYAI_API_KEY}` } }
        );
        const data = await resp.json();
        return jsonResponse({
          token: data.token,
          agent_id: env.AGENT_ID || 'agent_6e4f857ba75b420cb4ea523bccd94ead'
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Session creation (generate UUID) ──
    if (path === '/api/ws' && method === 'GET') {
      const sessionId = crypto.randomUUID();
      return jsonResponse({ session_id: sessionId });
    }

    // ── WebSocket upgrade → Durable Object ──
    const wsMatch = path.match(/^\/api\/ws\/([0-9a-f-]+)$/);
    if (wsMatch && method === 'GET') {
      const uuid = wsMatch[1];
      const doId = env.CHECKIN_DO.idFromName(uuid);
      const stub = env.CHECKIN_DO.get(doId);
      return stub.fetch(request);
    }

    // ── Presigned R2 upload URL ──
    if (path === '/api/upload-url' && method === 'GET') {
      const key = `ids/${crypto.randomUUID()}.jpg`;
      // R2 presigned URLs: use the S3-compatible interface
      // For Workers, we return the key and let the client PUT via the worker proxy
      // or we can generate a signed URL using R2's S3 API
      try {
        // Generate presigned URL using R2's public bucket or worker proxy
        const uploadUrl = `https://${url.hostname}/api/upload/${key}`;
        return jsonResponse({ upload_url: uploadUrl, r2_key: key });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── R2 upload proxy (PUT through worker) ──
    const uploadMatch = path.match(/^\/api\/upload\/(.+)$/);
    if (uploadMatch && method === 'PUT') {
      const key = uploadMatch[1];
      try {
        const contentType = request.headers.get('Content-Type') || 'image/jpeg';
        await env.R2_DOCS.put(key, request.body, {
          httpMetadata: { contentType },
        });
        return jsonResponse({ ok: true, key });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: list all ──
    if (path === '/api/businesses' && method === 'GET') {
      try {
        const { results } = await env.DB.prepare('SELECT * FROM businesses').all();
        return jsonResponse({ businesses: results });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: get questions ──
    const questionsMatch = path.match(/^\/api\/businesses\/([^/]+)\/questions$/);
    if (questionsMatch) {
      const bizId = questionsMatch[1];
      try {
        if (method === 'GET') {
          const biz = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(bizId).first();
          if (!biz) return jsonResponse({ error: 'Business not found' }, 404);
          const { results } = await env.DB.prepare(
            'SELECT * FROM business_questions WHERE business_id = ? ORDER BY order_index'
          ).bind(bizId).all();
          return jsonResponse({ business: biz, questions: results });
        }
        if (method === 'POST') {
          const body = await request.json();
          const qId = body.id || `q-${bizId}-${Date.now()}`;
          await env.DB.prepare(
            'INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(qId, bizId, body.field_key, body.question_text, body.order_index, body.validation_type || 'text').run();
          return jsonResponse({ ok: true, id: qId });
        }
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM business_questions WHERE business_id = ?').bind(bizId).run();
          return jsonResponse({ ok: true });
        }
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: create ──
    if (path === '/api/businesses' && method === 'POST') {
      try {
        const body = await request.json();
        const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await env.DB.prepare(
          'INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, body.name, body.business_type, body.welcome_message || 'Welcome!', body.voice_persona || 'anna', body.requires_id_scan ?? 1).run();
        return jsonResponse({ ok: true, id });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: update ──
    const bizMatch = path.match(/^\/api\/businesses\/([^/]+)$/);
    if (bizMatch) {
      const id = bizMatch[1];
      try {
        if (method === 'GET') {
          const biz = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first();
          if (!biz) return jsonResponse({ error: 'Business not found' }, 404);
          return jsonResponse(biz);
        }
        if (method === 'PUT') {
          const body = await request.json();
          await env.DB.prepare(
            'UPDATE businesses SET name=?, business_type=?, welcome_message=?, voice_persona=?, requires_id_scan=? WHERE id=?'
          ).bind(body.name, body.business_type, body.welcome_message, body.voice_persona, body.requires_id_scan ?? 1, id).run();
          return jsonResponse({ ok: true });
        }
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM business_questions WHERE business_id = ?').bind(id).run();
          await env.DB.prepare('DELETE FROM businesses WHERE id = ?').bind(id).run();
          return jsonResponse({ ok: true });
        }
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Fallback ──
    return jsonResponse({ error: 'Not found' }, 404);
  },
};

// ── Durable Object export (must be re-exported for Wrangler) ──
export { CheckinSession };

// Virtualobby API — Cloudflare Worker
// Voice-powered reception agent: D1-backed businesses, R2 uploads, AssemblyAI proxy.

import { CheckinSession } from './checkin-do.js';

// ── CORS ──────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    // Every response here is live, frequently-changing admin/business data —
    // never let a browser, the Telegram in-app WebView, or an intermediate
    // proxy cache it (the plain `fetch()` calls in admin.html/app.js don't
    // set their own cache options, so nothing else was ruling this out).
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

function safeJsonParse(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// admin.html derives a business's id by slugifying its name client-side,
// with no uniqueness check — two businesses with names that slugify the
// same way (or the same name typed twice) would otherwise hit D1's
// UNIQUE constraint on businesses.id and fail the whole create. Instead,
// append -2, -3, ... until a free id is found.
async function uniqueBusinessId(env, baseId) {
  let id = baseId;
  let suffix = 2;
  while (await env.DB.prepare('SELECT 1 FROM businesses WHERE id = ?').bind(id).first()) {
    id = `${baseId}-${suffix}`;
    suffix++;
  }
  return id;
}

// ── Telegram initData verification ───────────────────────────────────────
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Verifies the HMAC and freshness of Telegram.WebApp.initData. Returns the
// parsed { user, authDate } on success, or null if it's missing/invalid/spoofed.
async function verifyTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const enc = new TextEncoder();
  const secretKey = await hmacSha256(enc.encode('WebAppData'), enc.encode(botToken));
  const computed = await hmacSha256(secretKey, enc.encode(dataCheckString));

  if (toHex(computed) !== hash) return null;

  const authDate = Number(params.get('auth_date') || '0');
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  return { user, authDate };
}

// Enforces that the request comes from a Telegram user in ADMIN_TELEGRAM_IDS.
// The client sends initData verbatim in the X-Telegram-Init-Data header —
// this is the server-side check the client-side gate in admin.html can't do on its own.
async function requireAdmin(request, env) {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { ok: false, status: 500, error: 'Server misconfigured: missing TELEGRAM_BOT_TOKEN' };

  const verified = await verifyTelegramInitData(initData, botToken);
  if (!verified || !verified.user) return { ok: false, status: 401, error: 'Unauthorized: invalid or missing Telegram session' };

  const adminIds = (env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!adminIds.includes(String(verified.user.id))) return { ok: false, status: 403, error: 'Forbidden: not an admin' };

  return { ok: true, user: verified.user };
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
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error('AssemblyAI token error:', resp.status, errText);
          return jsonResponse({ error: `AssemblyAI token error: ${resp.status}` }, 502);
        }
        const data = await resp.json();
        if (!data.token) {
          console.error('AssemblyAI returned no token:', JSON.stringify(data));
          return jsonResponse({ error: 'No token returned from AssemblyAI' }, 502);
        }
        return jsonResponse({ token: data.token });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Session creation (generate UUID) ──
    if (path === '/api/ws' && method === 'GET') {
      const sessionId = crypto.randomUUID();
      return jsonResponse({ session_id: sessionId });
    }

    // ── WebSocket upgrade → Durable Object (GET), ID photo upload → Durable
    //    Object (PUT). Routing the upload through the DO instead of a bare R2
    //    proxy means it's only accepted while that visitor's own session is
    //    actually waiting for a scan — no open write endpoint into the bucket.
    const wsMatch = path.match(/^\/api\/ws\/([0-9a-f-]+)$/);
    if (wsMatch && (method === 'GET' || method === 'PUT')) {
      const uuid = wsMatch[1];
      const doId = env.CHECKIN_DO.idFromName(uuid);
      const stub = env.CHECKIN_DO.get(doId);
      if (method === 'GET') return stub.fetch(request);

      const doResp = await stub.fetch(request);
      const headers = new Headers(doResp.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(doResp.body, { status: doResp.status, headers });
    }

    // ── Businesses: list all ──
    if (path === '/api/businesses' && method === 'GET') {
      try {
        // registrations_count lets the admin's Submissions tab show, at a
        // glance, which businesses actually have visitors — without it
        // there was no way to tell an empty business apart from one that
        // just hadn't been picked from the (bare, count-less) selector yet.
        const { results } = await env.DB.prepare(
          `SELECT b.*, (SELECT COUNT(*) FROM guest_registrations g WHERE g.business_id = b.id) AS registrations_count
           FROM businesses b`
        ).all();
        return jsonResponse({ businesses: results });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: get/replace questions ──
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
          const auth = await requireAdmin(request, env);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
          const body = await request.json();

          // Bulk replace — this is what admin.html sends: { questions: [...] }
          if (Array.isArray(body.questions)) {
            await env.DB.prepare('DELETE FROM business_questions WHERE business_id = ?').bind(bizId).run();
            let i = 0;
            for (const q of body.questions) {
              i++;
              const text = typeof q === 'string' ? q : (q.text || q.question_text || q.question || '');
              if (!text) continue;
              const fieldKey = (typeof q === 'object' && (q.field || q.field_key)) || `q${i}`;
              const qId = (typeof q === 'object' && q.id) || `q-${bizId}-${i}-${Date.now()}`;
              await env.DB.prepare(
                'INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(qId, bizId, fieldKey, text, i, (typeof q === 'object' && q.validation_type) || 'text').run();
            }
            return jsonResponse({ ok: true, count: i });
          }

          // Single insert: { field_key, question_text, order_index, validation_type }
          if (!body.field_key || !body.question_text) {
            return jsonResponse({ error: 'Missing field_key or question_text' }, 400);
          }
          const qId = body.id || `q-${bizId}-${Date.now()}`;
          await env.DB.prepare(
            'INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(qId, bizId, body.field_key, body.question_text, body.order_index ?? 0, body.validation_type || 'text').run();
          return jsonResponse({ ok: true, id: qId });
        }
        if (method === 'DELETE') {
          const auth = await requireAdmin(request, env);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
          await env.DB.prepare('DELETE FROM business_questions WHERE business_id = ?').bind(bizId).run();
          return jsonResponse({ ok: true });
        }
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: list registrations (real PII — admin only) ──
    const registrationsMatch = path.match(/^\/api\/businesses\/([^/]+)\/registrations$/);
    if (registrationsMatch && method === 'GET') {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
      const bizId = registrationsMatch[1];
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM guest_registrations WHERE business_id = ? ORDER BY created_at DESC'
        ).bind(bizId).all();
        const registrations = (results || []).map((r) => ({
          ...r,
          answers: safeJsonParse(r.answers_json),
          ocr: safeJsonParse(r.ocr_data_json),
        }));
        return jsonResponse({ registrations });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: delete a single registration ──
    const registrationMatch = path.match(/^\/api\/businesses\/([^/]+)\/registrations\/([^/]+)$/);
    if (registrationMatch && method === 'DELETE') {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
      const [, bizId, regId] = registrationMatch;
      try {
        await env.DB.prepare('DELETE FROM guest_registrations WHERE id = ? AND business_id = ?').bind(regId, bizId).run();
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Businesses: create ──
    if (path === '/api/businesses' && method === 'POST') {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
      try {
        const body = await request.json();
        if (!body.name) return jsonResponse({ error: 'Missing name' }, 400);
        const requestedId = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const id = await uniqueBusinessId(env, requestedId);
        await env.DB.prepare(
          'INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, body.name, body.business_type, body.welcome_message || 'Welcome!', body.voice_persona || 'anna', body.requires_id_scan ?? 1).run();

        // The admin UI submits template/custom questions inline on create —
        // these were previously silently dropped (only the business row got saved).
        const questions = Array.isArray(body.questions) ? body.questions : [];
        let i = 0;
        for (const q of questions) {
          i++;
          const text = typeof q === 'string' ? q : (q.text || q.question_text || q.question || '');
          if (!text) continue;
          const fieldKey = (typeof q === 'object' && (q.field || q.field_key)) || `q${i}`;
          const qId = `q-${id}-${i}-${Date.now()}`;
          await env.DB.prepare(
            'INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(qId, id, fieldKey, text, i, (typeof q === 'object' && q.validation_type) || 'text').run();
        }

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
          const auth = await requireAdmin(request, env);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
          const body = await request.json();
          await env.DB.prepare(
            'UPDATE businesses SET name=?, business_type=?, welcome_message=?, voice_persona=?, requires_id_scan=? WHERE id=?'
          ).bind(body.name, body.business_type, body.welcome_message, body.voice_persona, body.requires_id_scan ?? 1, id).run();
          return jsonResponse({ ok: true });
        }
        if (method === 'DELETE') {
          const auth = await requireAdmin(request, env);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
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

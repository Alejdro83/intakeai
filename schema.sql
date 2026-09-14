-- Virtualobby D1 Schema v2
-- 4 tables: businesses, business_questions, guest_registrations, token_rate_limits

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  welcome_message TEXT DEFAULT 'Welcome! I will help you check in.',
  -- Actual AssemblyAI TTS voice — must be one of the documented catalog IDs
  -- (anna, michael, george, mary, eve, paul, jane, charles, vera, alba, jean,
  -- giovanni, lola, juergen, rafael, estelle). Never a free-text description.
  voice_id TEXT DEFAULT 'anna',
  -- Free-text tone/personality guidance fed into the agent's system prompt
  -- (e.g. "warm and reassuring, speaks slowly"). NOT a voice selector — admin
  -- UI historically let people type descriptions into what used to be the
  -- only voice field, which AssemblyAI's output.voice can't actually use.
  voice_persona TEXT DEFAULT '',
  requires_id_scan INTEGER DEFAULT 1,
  -- Optional: POSTed with the check-in payload when a registration
  -- completes, so a business's existing CRM/PMS/EHR can ingest visitor
  -- data without any custom integration on their end. Empty = disabled.
  webhook_url TEXT DEFAULT '',
  -- Optional shared secret. When set, the webhook request carries an
  -- X-Virtualobby-Signature: sha256=<hmac> header over the raw JSON body,
  -- so the receiving system can verify the payload actually came from us.
  webhook_secret TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_questions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  validation_type TEXT DEFAULT 'text',
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS guest_registrations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  answers_json TEXT,
  ocr_data_json TEXT,
  id_image_r2_key TEXT,
  status TEXT DEFAULT 'completed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Backs the /api/token rate limiter. One row per IP ever seen; D1 serializes
-- writes to the same row, so the upsert in worker.js is a real cross-request
-- limit (unlike an in-memory Map, which is per-isolate and doesn't hold up
-- under real concurrent load — verified: 12 truly simultaneous requests from
-- one IP all got through it). No cleanup job for stale rows yet — fine at
-- this scale, would need one if the IP set grows large over time.
CREATE TABLE IF NOT EXISTS token_rate_limits (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

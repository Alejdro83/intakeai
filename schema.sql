-- Virtualobby D1 Schema v2
-- 3 tables: businesses, business_questions, guest_registrations

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  welcome_message TEXT DEFAULT 'Welcome! I will help you check in.',
  voice_persona TEXT DEFAULT 'anna',
  requires_id_scan INTEGER DEFAULT 1,
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

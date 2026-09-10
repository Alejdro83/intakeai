# Virtualobby — Implementation Plan (Revised v2)

> AssemblyAI Voice Agent Hackathon — Deadline: September 30, 2026
> Architecture: Cloudflare (Durable Objects + D1 + R2 + Pages + Workers)
> Voice: AssemblyAI Voice Agent API (browser-direct WebSocket)
> **v2:** Technical review fixes applied — see changelog at bottom

---

## 📋 Overview

**Goal:** A Telegram Mini App where visitors check in via voice + camera. The agent greets them, scans their ID, asks business-specific questions by voice, confirms, and registers.

**Current state:** ~70% built but fragmented. Worker deployed, Mini App exists, agent defined but not published. Need to refactor onto Durable Objects + D1 architecture.

### Revised Architecture Flow

```
User opens Telegram bot → Mini App loads
    ↓
Browser parses start_param to extract business_id
    ↓
Browser requests UUID-based session from Worker (GET /api/ws)
    → Worker generates UUID, creates DO instance <uuid>, returns UUID to browser
    ↓
Browser opens WebSocket to DO: /api/ws/<uuid>
    → First message: { "type": "start", "business_id": "clinic-main" }
    ↓
Browser requests session token from Worker (GET /api/token)
    → Worker proxies: GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60
    → Returns: { "token": "..." }
    ↓
Browser opens WebSocket to AssemblyAI: wss://agents.assemblyai.com/v1/ws?token=<token>
    ↓
DO loads business config from D1, sends welcome text to browser
AssemblyAI plays greeting voice
    ↓
Voice conversation: user speaks → AssemblyAI transcribes →
browser sends USER_TRANSCRIPT text to DO
    ↓
DO FSM: greeting → questions (loop) → camera scan → confirm → done
    ↓
Camera capture → presigned R2 upload → R2 key sent to DO → Vision API → OCR data
    ↓
DO saves everything to D1 guest_registrations
    ↓
CHECKIN_COMPLETE sent to browser + AssemblyAI speaks confirmation
```

### Key Architectural Decisions (Revised)

| Decision | Old | New | Rationale |
|----------|-----|-----|-----------|
| Session table | D1 `sessions` table | DO in-memory state | Simpler; DO already manages lifecycle |
| Voice relay | DO relays audio browser↔AssemblyAI | Browser connects to AssemblyAI directly | Lower latency, simpler DO, no audio in DO |
| OCR engine | Tesseract.js (client-side) | Vision model (Workers AI or external API) | Better accuracy, no 2MB WASM download |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS | Higher quality, consistent voice (AssemblyAI voice IDs only) |
| Admin dashboard | (implied framework) | Vanilla HTML/JS, fetch() to Worker API | No build step, fast to ship for hackathon |
| D1 tables | 4 tables | 3 tables (no sessions) | DO manages session state in memory |
| DO key | Per-business (`/api/ws/:businessId`) | Per-visitor UUID (`/api/ws/<uuid>`) | Prevents state collision between concurrent visitors |
| Image upload | base64 over WebSocket | Presigned R2 URL (browser→R2 direct) | 2-6MB base64 exceeds WS frame limits |
| Session token | `POST /v2/voice-agent/session` (wrong) | `GET agents.assemblyai.com/v1/token?product=voice_agent` | Correct documented endpoint |
| Voice persona | `"alloy"` (OpenAI voice) | `"anna"` (AssemblyAI voice) | Only AssemblyAI voice IDs are valid |

---

## Security Notes

> **Apply before any deployment.**

1. **API keys as Wrangler secrets** — `ASSEMBLYAI_API_KEY` and `AGENT_ID` must be stored as Wrangler secrets, NOT in `wrangler.toml` [vars]:
   ```bash
   wrangler secret put ASSEMBLYAI_API_KEY
   wrangler secret put AGENT_ID
   ```
2. **CORS headers** — All Worker API endpoints (`/api/*`) must return appropriate `Access-Control-Allow-Origin` headers. For Telegram Mini Apps, the origin is the Telegram WebView domain. Use `*` during development, restrict in production.
3. **initData validation** — Admin endpoints must validate `Telegram.WebApp.initData` using the bot token HMAC to prevent spoofed admin requests.

---

## Phase 1: Foundation (Days 1-2)

### 1.1 — D1 Database Schema
**Effort:** 1-2h | **Blocks:** 1.2, 1.3, 2.1

Create D1 database and define schema with **3 tables**.

**Files to create:** `schema.sql` and `seed.sql` (for reproducibility — judges clone and run).

```sql
-- schema.sql
-- Businesses (admin-managed)
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,                          -- e.g. "clinic-main"
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,                  -- clinic | lawyer | hotel | office
  welcome_message TEXT DEFAULT 'Welcome! I will help you check in.',
  voice_persona TEXT DEFAULT 'anna',            -- AssemblyAI voice ID (NOT OpenAI)
  requires_id_scan INTEGER DEFAULT 1,           -- 1 = prompt for ID scan, 0 = skip
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Business-specific questions (questionnaire template)
CREATE TABLE business_questions (
  id TEXT PRIMARY KEY,                          -- e.g. "q-clinic-appointment"
  business_id TEXT NOT NULL,                    -- FK → businesses.id
  field_key TEXT NOT NULL,                      -- e.g. "appointment", "purpose"
  question_text TEXT NOT NULL,                  -- e.g. "Do you have an appointment?"
  order_index INTEGER NOT NULL,                 -- question sequence
  validation_type TEXT DEFAULT 'text',          -- text | yes_no | number | date | email
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Guest registrations (final records)
CREATE TABLE guest_registrations (
  id TEXT PRIMARY KEY,                          -- UUID (crypto.randomUUID())
  business_id TEXT NOT NULL,                    -- FK → businesses.id
  answers_json TEXT,                            -- JSON: {"appointment": "yes", ...}
  ocr_data_json TEXT,                           -- JSON: {"name": "...", "id_number": "...", ...}
  id_image_r2_key TEXT,                         -- R2 path for document photo
  status TEXT DEFAULT 'completed',              -- completed | partial | error
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);
```

**Commands:**
```bash
cd ~/intakeai
wrangler d1 create virtualobby-db
# Note the output ID, add to wrangler.toml:
# [[d1_databases]]
# binding = "DB"
# database_name = "virtualobby-db"
# database_id = "<returned-id>"
```

**Acceptance:** Tables created, `wrangler d1 execute virtualobby-db --command "SELECT name FROM sqlite_master WHERE type='table'"` returns `businesses`, `business_questions`, `guest_registrations` (3 tables). Verify with `PRAGMA table_info(businesses)` etc. `schema.sql` and `seed.sql` files exist in repo root.

---

### 1.2 — R2 Bucket for Document Photos
**Effort:** 15min | **Blocks:** 2.3

```bash
wrangler r2 bucket create virtualobby-docs
# Add to wrangler.toml:
# [[r2_buckets]]
# binding = "R2_DOCS"
# bucket_name = "virtualobby-docs"
```

**Acceptance:** `wrangler r2 bucket list` shows `virtualobby-docs`.

---

### 1.3 — Seed Data
**Effort:** 30min | **Blocks:** 2.1

Insert default business + questions via D1. Also create `seed.sql` for reproducibility.

**File:** `seed.sql`

```sql
INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan)
VALUES ('clinic-main', 'Demo Clinic', 'clinic', 'Welcome to Demo Clinic! I will help you check in for your visit.', 'anna', 1);

INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES
  ('q-apt-1', 'clinic-main', 'appointment', 'Do you have an appointment today?', 1, 'yes_no'),
  ('q-apt-2', 'clinic-main', 'doctor_name', 'Which doctor are you visiting?', 2, 'text'),
  ('q-apt-3', 'clinic-main', 'reason', 'What is the reason for your visit?', 3, 'text'),
  ('q-apt-4', 'clinic-main', 'insurance', 'Do you have insurance?', 4, 'yes_no'),
  ('q-apt-5', 'clinic-main', 'emergency_contact', 'What is your emergency contact phone number?', 5, 'text');
```

Run via:
```bash
wrangler d1 execute virtualobby-db --file ./seed.sql
```

**Acceptance:** `SELECT * FROM businesses` and `SELECT * FROM business_questions WHERE business_id = 'clinic-main'` return data. `seed.sql` exists in repo root.

---

### 1.4 — Publish AssemblyAI Agent
**Effort:** 30min | **Blocks:** 2.4

```bash
cd ~/intakeai
# Ensure .env has ASSEMBLYAI_API_KEY
python publish.py  # publishes agents/intake-clinic.jsonc
# Save the returned AGENT_ID
```

**Acceptance:** Agent appears in AssemblyAI dashboard, agent_id saved in `.env`. Store as Wrangler secret:
```bash
wrangler secret put AGENT_ID
```

---

### 1.5 — AssemblyAI Session Token Endpoint (CORRECTED)
**Effort:** 1-2h | **Blocks:** 2.4
**Dependencies:** 1.4

**File:** `api/worker.js` (new route)

The browser needs a temporary token to connect directly to the AssemblyAI Voice Agent WebSocket. The Worker mints this token server-side (keeping the API key secret).

**Endpoint:** `GET /api/token` (proxies AssemblyAI's token endpoint)

> **⚠️ REVIEW FIX:** The previous plan used `POST /v2/voice-agent/session` — that endpoint does not exist. The correct flow (from working `deployment/browser/server.py`) is:
> - Worker proxies: `GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60`
> - Returns: `{ "token": "..." }`
> - Browser constructs: `wss://agents.assemblyai.com/v1/ws?token=<token>`

```javascript
// In api/worker.js
async function handleSessionToken(env) {
  const resp = await fetch(
    'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60',
    {
      headers: {
        'Authorization': `Bearer ${env.ASSEMBLYAI_API_KEY}`,
      },
    }
  );
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: 'Failed to mint token' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const data = await resp.json();
  // Return the token — browser will construct: wss://agents.assemblyai.com/v1/ws?token=<token>
  return new Response(JSON.stringify({ token: data.token }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

**Acceptance:**
- `curl /api/token` returns `{ "token": "..." }`.
- Token is never exposed in client-side source code.
- Browser uses `wss://agents.assemblyai.com/v1/ws?token=<token>` to connect.

---

## Phase 2: Core Implementation (Days 3-5)

### 2.1 — Durable Object: CheckinSession
**Effort:** 4-6h | **Blocks:** 2.2, 2.3, 2.4
**Dependencies:** 1.1

**File:** `api/checkin-do.js`

**CRITICAL: The DO does NOT relay audio. The DO does NOT connect to AssemblyAI.**
The DO ONLY manages: FSM state machine + D1 queries + R2 storage.
The browser connects to AssemblyAI directly for voice/audio.

**CRITICAL: Each visitor gets their own DO instance (UUID-based), NOT per-business.**

> **⚠️ REVIEW FIX:** The previous plan used `/api/ws/:businessId` as the DO key, which meant all visitors to the same business shared one DO instance — causing state collision. The fix:
> - Worker generates UUID per session: `crypto.randomUUID()`
> - DO key is the UUID, not the business ID
> - Business ID is passed as the first WebSocket message after connect

FSM states:
```
idle → greeting → asking_questions (loops) → scanning_doc → confirming → done
```

Key responsibilities:
- `webSocketOpen()` — Wait for `start` message with `business_id`
- First `webSocketMessage({ type: "start", business_id })` — Read business config from D1, send welcome text to browser
- `webSocketMessage()` — Process incoming TEXT messages (commands, transcripts from browser, R2 keys for OCR)
- `webSocketClose()` — Clean up in-memory state
- `alarm()` — Session timeout (auto-close after 10min idle)
- State transitions with validation (can't jump from greeting to done)
- Store partial answers in `this.state` (in-memory during session)
- On `confirmed`: write to D1 `guest_registrations` table with `crypto.randomUUID()` for the registration ID

**In-memory state shape:**
```javascript
this.state = {
  businessId: null,        // set on "start" message
  fsmState: 'idle',
  businessConfig: { /* from D1 */ },
  questions: [ /* from D1 business_questions */ ],
  currentQuestionIndex: 0,
  answers: {},
  ocrData: null,
  idImageR2Key: null,
  startedAt: Date.now(),
};
```

Message protocol (browser ↔ DO):
```json
// Browser → DO
{ "type": "start", "business_id": "clinic-main" }
{ "type": "user_transcript", "text": "yes I have an appointment" }
{ "type": "id_uploaded", "r2_key": "ids/clinic-main/abc123.jpg" }
{ "type": "confirm" }

// DO → Browser
{ "type": "welcome", "text": "Welcome to Demo Clinic! I will help you check in.", "voice_persona": "anna" }
{ "type": "state", "state": "asking_questions", "question": "Do you have an appointment today?" }
{ "type": "ocr_result", "fields": { "name": "Alejandro", "id_number": "12345678" } }
{ "type": "summary", "answers": { "appointment": "yes", "doctor_name": "Smith" }, "ocr": { "name": "Alejandro" } }
{ "type": "checkin_complete", "registration_id": "uuid-here" }
{ "type": "error", "message": "..." }
```

D1 writes on confirm:
```javascript
// registration ID generated via crypto.randomUUID()
await env.DB.prepare(
  'INSERT INTO guest_registrations (id, business_id, answers_json, ocr_data_json, id_image_r2_key, status) VALUES (?, ?, ?, ?, ?, ?)'
).bind(crypto.randomUUID(), this.state.businessId, JSON.stringify(this.state.answers), JSON.stringify(this.state.ocrData), this.state.idImageR2Key, 'completed').run();
```

**Acceptance:** DO handles concurrent visitors without state collision. Each visitor gets isolated state in their own DO instance.

---

### 2.2 — Worker Router (API Layer)
**Effort:** 3-4h | **Blocks:** 2.3, 2.4
**Dependencies:** 2.1

**File:** `api/worker.js`

Routes:
```
GET  /api/token              → Mint AssemblyAI session token (see 1.5)
GET  /api/ws                 → Generate UUID, create DO instance, return UUID to browser
GET  /api/ws/:uuid           → WebSocket upgrade to DO instance <uuid>
GET  /api/upload-url         → Generate presigned R2 PUT URL for image upload
GET  /api/businesses         → List businesses (admin)
POST /api/businesses         → Create business (admin)
GET  /api/businesses/:id     → Get business config
GET  /api/businesses/:id/registrations → List registrations (admin)
```

> **⚠️ REVIEW FIX:** DO routing changed from `/api/ws/:businessId` to UUID-based. The Worker generates the UUID and creates the DO instance.

**Session creation flow (Worker):**
```javascript
// GET /api/ws — Worker generates UUID and returns it
async function handleNewSession(env) {
  const sessionId = crypto.randomUUID();
  // The DO instance is created on first connect via idFromName(sessionId)
  return new Response(JSON.stringify({ session_id: sessionId }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// GET /api/ws/:uuid — WebSocket upgrade to DO
async function handleWSConnect(env, uuid) {
  const doId = env.CHECKIN_DO.idFromName(uuid);
  const stub = env.CHECKIN_DO.get(doId);
  return stub.fetch(request);  // forward the WS upgrade
}
```

**Presigned upload flow (Worker):**
```javascript
// GET /api/upload-url — Generate presigned R2 PUT URL
async function handleUploadUrl(env, request) {
  const key = `ids/${crypto.randomUUID()}.jpg`;
  const url = await env.R2_DOCS.createPresignedUrl(key, {
    method: 'PUT',
    expiresIn: 300, // 5 minutes
  });
  return new Response(JSON.stringify({ upload_url: url, r2_key: key }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

> **⚠️ REVIEW FIX:** All API responses include CORS headers. Admin endpoints validate `Telegram.WebApp.initData` HMAC.

**Acceptance:** `GET /api/ws` returns `{ "session_id": "<uuid>" }`. `GET /api/token` returns token. `GET /api/upload-url` returns presigned URL and key. All endpoints have CORS headers.

---

### 2.3 — Frontend Refactor (Telegram Mini App)
**Effort:** 4-6h | **Blocks:** 2.5
**Dependencies:** 2.2, 1.2

**Files:** `telegram/webapp/index.html`, `app.js`, `style.css`

Major changes:
- **Remove** Tesseract.js OCR entirely (OCR now server-side via Vision model)
- **Add** Telegram `start_param` parsing to extract business ID
- **Add** WebSocket connection to DO via Worker (UUID-based, for state management)
- **Add** WebSocket connection to AssemblyAI Voice Agent (for voice/audio)
- **Add** session token fetch: `GET /api/token` → get token → connect to `wss://agents.assemblyai.com/v1/ws?token=<token>`
- **Add** presigned R2 upload for ID photos (instead of base64 over WebSocket)
- **Remove** all Web Speech API usage (TTS now handled by AssemblyAI native TTS)
- **Simplify** UI to voice-first: big mic button, transcript display, status indicator

> **⚠️ REVIEW FIX:** Telegram `start_param` parsing (was missing):
```javascript
// Parse Telegram start_param to extract business ID
// Format: start_param = "business_clinic-main" → extract "clinic-main"
const tg = window.Telegram?.WebApp;
const startParam = tg?.initDataUnsafe?.start_param || '';
const businessId = startParam.startsWith('business_')
  ? startParam.replace('business_', '')
  : 'clinic-main'; // fallback default
```

> **⚠️ REVIEW FIX:** UUID-based DO connection (was businessId-based):
```javascript
// 1. Request session from Worker (returns UUID)
const sessionResp = await fetch('/api/ws');
const { session_id } = await sessionResp.json();

// 2. Connect to DO via UUID
const doWs = new WebSocket(`wss://${location.host}/api/ws/${session_id}`);

// 3. Send business_id as first message after connect
doWs.onopen = () => {
  doWs.send(JSON.stringify({ type: 'start', business_id: businessId }));
};
```

> **⚠️ REVIEW FIX:** Correct AssemblyAI token flow (was using wrong endpoint):
```javascript
// 4. Connect to AssemblyAI for voice (correct endpoint)
const tokenResp = await fetch('/api/token');
const { token } = await tokenResp.json();
const assemblyWs = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`);
```

> **⚠️ REVIEW FIX:** Presigned R2 upload for ID images (was base64 over WebSocket):
```javascript
// 5. Image upload via presigned R2 URL (NOT base64 over WebSocket)
async function uploadIdImage(file) {
  // Get presigned URL from Worker
  const resp = await fetch('/api/upload-url');
  const { upload_url, r2_key } = await resp.json();

  // Upload directly to R2
  await fetch(upload_url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'image/jpeg' },
  });

  // Send only the R2 key to DO (not the image data)
  doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key: r2_key }));
}
```

```javascript
// 6. When AssemblyAI transcribes user speech, forward to DO
assemblyWs.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'final_transcript') {
    doWs.send(JSON.stringify({ type: 'user_transcript', text: msg.text }));
  }
};
```

UI flow:
1. Open → parse `start_param` → request session UUID → connect DO WS → send `start` with `business_id` → fetch token → connect AssemblyAI WS → DO sends welcome text → AssemblyAI speaks greeting
2. Voice conversation: user speaks → AssemblyAI transcribes → browser forwards transcript to DO → DO sends next question → AssemblyAI speaks question
3. Document scan → DO sends `{ type: "scan_prompt" }` → camera opens → photo captured → presigned upload to R2 → R2 key sent to DO → DO calls Vision API → sends OCR result back
4. Questions loop → agent speaks question → user answers by voice → transcript shown → DO processes → next question
5. Summary → DO sends all answers + OCR data → agent reads back → user confirms by voice or tap
6. Done → `checkin_complete` → show confirmation + "You're checked in"

> **⚠️ REVIEW FIX:** Test dual-WS in Telegram WebView early on **Day 2** (not Day 5) to catch compatibility issues before investing in the full stack.

**Acceptance:** Can open Mini App, see greeting, hear voice, speak and get transcribed, receive questions by voice, camera works for ID scan. ID image uploads via presigned URL, not base64.

---

### 2.4 — AssemblyAI Browser Connection (REVISED)
**Effort:** 2-3h | **Blocks:** 2.5
**Dependencies:** 1.4, 1.5, 2.3

**This task is simpler than the original 2.4** because the browser connects to AssemblyAI directly — the DO does NOT relay audio.

**What this task covers:**
1. Wire up session token flow: browser calls `GET /api/token` → receives token → opens WebSocket to `wss://agents.assemblyai.com/v1/ws?token=<token>`
2. Configure AssemblyAI agent with `voice_persona` from business config (use AssemblyAI voice IDs only: `anna`, `michael`, `george`, `mary`, `eve`, `paul`, `jane`, etc. — see [voice catalog](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices))
3. Handle AssemblyAI WebSocket events in the browser:
   - `session_started` → ready
   - `transcript` (partial/final) → display in UI + forward final to DO
   - `agent_audio` → play through AudioContext (AssemblyAI handles TTS)
   - `error` → reconnect logic
4. Pass business-specific greeting to AssemblyAI so it speaks the correct welcome message
5. When DO sends a question text to the browser, the browser needs AssemblyAI to speak it:
   - Option A: Use AssemblyAI's `send_text` or `generate_reply` API to inject text for the agent to speak
   - Option B: The AssemblyAI agent is configured as a tool-calling agent that calls back to a Worker endpoint for the current question text (HTTP tool)

**Recommended approach:** The AssemblyAI agent uses HTTP tools to call the Worker for the current question/context. The Worker reads from the DO's state. This keeps the agent self-directed.

```
AssemblyAI agent HTTP tool: GET /api/context/:sessionId
  → Returns: { "current_question": "Do you have an appointment?", "state": "asking_questions", ... }
```

This way AssemblyAI's LLM naturally asks the right question, the browser doesn't need to inject text, and the voice conversation feels natural.

**Acceptance:**
- Browser opens WebSocket to AssemblyAI using minted token (`wss://agents.assemblyai.com/v1/ws?token=...`).
- Voice conversation works: user speaks, agent responds.
- Agent asks the correct business questions from D1 (via HTTP tool callback).
- Transcripts flow: AssemblyAI → browser → DO.

---

### 2.5 — End-to-End Integration Test
**Effort:** 2-3h | **Blocks:** 3.1
**Dependencies:** 2.3, 2.4

Test script:
1. Open `@Virtu_intake_bot` in Telegram
2. Tap "Open Virtualobby"
3. App loads, parses `start_param`, requests session UUID, connects both WebSockets
4. Agent greets by voice: "Welcome to Demo Clinic! I will help you check in."
5. User speaks: "Yes I have an appointment" → transcript appears, DO advances state
6. Agent asks next question by voice
7. User answers all questions by voice
8. Agent asks to scan ID → camera opens → photo taken → uploaded via presigned R2 URL → OCR results shown
9. Agent reads back summary → user confirms
10. "You're checked in!" → data in D1

**Acceptance:** Full flow works end-to-end. Two concurrent visitors to the same business get isolated sessions (no state collision).

---

## Phase 3: Polish & Demo Prep (Days 6-7)

### 3.1 — Multi-language Support
**Effort:** 2-3h | **Dependencies:** 2.5

- AssemblyAI Voice Agent handles multi-language natively (auto-detect)
- Business config: add `language` field to D1 businesses table
- Update agent system prompt to respond in detected language
- Add language indicator in UI

**Acceptance:** Same flow works in English and Spanish.

---

### 3.2 — Admin Panel
**Effort:** 3-4h | **Dependencies:** 2.2

**File:** `telegram/webapp/admin.html` (vanilla HTML/JS, no build step)

Features:
- View businesses list
- Add/edit business (name, welcome message, voice_persona, requires_id_scan)
- View questions per business (add/edit/reorder)
- View registrations per business (read-only table)
- Generate QR codes per business

> **⚠️ REVIEW FIX:** Admin endpoints validate `Telegram.WebApp.initData` HMAC using bot token to prevent spoofed requests. Admin page parses `initDataUnsafe.user.id` and checks against allowed admin IDs.

**Acceptance:** Admin can create a new business, add questions, view registrations, generate QR code.

---

### 3.3 — Error Handling & Edge Cases
**Effort:** 2-3h | **Dependencies:** 2.5

Handle:
- **WebSocket disconnect** (DO or AssemblyAI) → auto-reconnect (3 attempts), then show error
- **Session token expired** (60s) → re-fetch from `/api/token`, reconnect AssemblyAI WS
- **Session timeout** (10min idle via DO alarm) → save partial data to D1 (status: 'partial'), notify user
- **Audio not supported** → fallback to text input field, send as `user_transcript`
- **Camera denied** → skip document scan (`requires_id_scan=0` or manual skip), ask info verbally
- **Vision API failure** → fall back to asking user to describe their document verbally
- **AssemblyAI rate limit** → exponential backoff on token requests
- **Presigned URL expired** → re-request from `/api/upload-url`

**Acceptance:** App doesn't crash on any of the above scenarios. Graceful degradation in all cases.

---

### 3.4 — QR Code & Business Onboarding
**Effort:** 1h | **Dependencies:** 3.2

- Generate QR code per business: `https://t.me/Virtu_intake_bot?start=business_<id>`
- Simple admin flow to add new business + questions (via admin.html)
- New business gets default welcome message and 0 questions (admin adds them)

**Acceptance:** Scan QR → opens Telegram bot → correct business pre-selected via `start_param`. Admin can add a new business from the admin panel.

---

## Phase 4: Demo & Submission (Days 8-9)

### 4.1 — Demo Video
**Effort:** 3-4h | **Dependencies:** 3.1

Script:
1. **Hook (10s):** "What if your phone WAS the reception desk?"
2. **Problem (15s):** Long waits, paper forms, language barriers
3. **Solution (30s):** Open Telegram → voice check-in → done in 90 seconds
4. **Tech (20s):** AssemblyAI Voice Agent API + Cloudflare Durable Objects
5. **Live demo (45s):** Full check-in flow on a real phone (voice + camera)
6. **Multi-language (15s):** Same flow in Spanish
7. **Close (10s):** "Virtualobby — your phone is the reception desk"

**Acceptance:** 2-3 minute video, clear audio, real device footage.

---

### 4.2 — Submission Package
**Effort:** 1-2h | **Dependencies:** 4.1

- GitHub repo clean and documented
- README with architecture diagram, setup instructions, demo link
- Environment variables documented in `.env.example`
- Demo URL live and stable
- `schema.sql` and `seed.sql` for reproducibility

**Acceptance:** Judge can clone repo, follow README, run locally.

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | ~~AssemblyAI session token endpoint wrong~~ | ~~Critical~~ | ~~—~~ | **FIXED v2:** Corrected to `GET agents.assemblyai.com/v1/token?product=voice_agent`. Verified against working `deployment/browser/server.py`. |
| 2 | ~~DO state collision (per-business key)~~ | ~~Critical~~ | ~~—~~ | **FIXED v2:** UUID-based DO instances. Each visitor gets isolated DO. |
| 3 | ~~Voice persona "alloy" (OpenAI, not AssemblyAI)~~ | ~~High~~ | ~~—~~ | **FIXED v2:** Changed to `"anna"` (AssemblyAI voice). All voice_persona values must use AssemblyAI voice catalog. |
| 4 | ~~Base64 images over WebSocket (2-6MB)~~ | ~~High~~ | ~~—~~ | **FIXED v2:** Presigned R2 URL upload. Browser uploads directly to R2, sends only key to DO. |
| 5 | Browser can't maintain two WebSocket connections simultaneously | **High** | Low | Both are standard WS; Telegram Mini App WebView supports it. **Test on Day 2** (not Day 5) to catch early. |
| 6 | Vision model OCR quality insufficient | **Medium** | Medium | Test with `@cf/meta/llama-3.2-11b-vision` early; fall back to external API (OpenAI Vision) if Workers AI accuracy is poor. |
| 7 | AssemblyAI agent can't ask dynamic questions via HTTP tools | **Medium** | Medium | Fallback: browser injects question text into AssemblyAI via `send_text` API. Test HTTP tool approach first. |
| 8 | D1 cold start latency causes slow greeting | **Low** | Low | Pre-warm with health check endpoint. Business config rarely changes, consider caching. |
| 9 | DO in-memory state lost on restart | **Medium** | Low | Re-read business config from D1 on reconnect. Partial answers are ephemeral by design (short sessions). |
| 10 | Telegram WebView limits (camera, microphone) | **Medium** | Low | Telegram Mini Apps support both. Test on real device in Phase 2. |
| 11 | API keys in wrangler.toml [vars] exposed | **Medium** | Low | **FIXED v2:** Use Wrangler secrets for `ASSEMBLYAI_API_KEY` and `AGENT_ID`. |
| 12 | Presigned URL expires before upload completes | **Low** | Low | 5-minute expiry is generous. Frontend re-requests if expired. |

---

## File Structure (Target)

```
intakeai/
├── agents/
│   └── intake-clinic.jsonc          # AssemblyAI agent definition (voice_id: "anna")
├── api/
│   ├── worker.js                    # Router + REST endpoints + token proxy + presigned URLs
│   ├── checkin-do.js                # Durable Object (FSM + D1/R2, UUID-based, NO audio relay)
│   └── data/
│       └── submissions.json         # Legacy (remove after D1 migration)
├── telegram/
│   └── webapp/
│       ├── index.html               # Main Mini App (dual WS: DO + AssemblyAI)
│       ├── app.js                   # Frontend logic (WS management + presigned upload + start_param parsing)
│       ├── style.css                # Mobile-first styles
│       ├── admin.html               # Admin panel (vanilla HTML/JS, fetch() only, initData HMAC validation)
│       └── visit.html               # Visit summary
├── deployment/
│   └── browser/                     # AssemblyAI browser deployment (reference)
├── wrangler.toml                    # CF config (Worker + D1 + R2 + DO). NO secrets in [vars].
├── schema.sql                       # D1 schema (3 tables, for reproducibility)
├── seed.sql                         # D1 seed data
├── publish.py                       # AssemblyAI agent publisher
├── lib.py                           # Shared Python utils
└── README.md
```

---

## Summary of Changes from Original Plan

| Area | Original Plan | Revised Plan |
|------|--------------|--------------|
| D1 Schema | 4 tables (businesses, questionnaires, submissions, sessions) | 3 tables (businesses, business_questions, guest_registrations). No sessions table. |
| Voice Architecture | DO relays audio browser↔AssemblyAI (Option A) | Browser connects to AssemblyAI directly. DO receives text transcripts only. |
| DO responsibilities | FSM + audio relay + D1 + R2 | FSM + D1 queries + R2 storage. NO audio. |
| OCR | Tesseract.js client-side | Vision model server-side (Workers AI or external API) |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS |
| Admin Dashboard | (implied React/framework) | Vanilla HTML/JS, fetch() to Worker API |
| Session Token | Not addressed | WorkerThe file wasn't written yet — my previous response was truncated before the write_file executed. Let me write it now in one go:<tool_call>
<function=execute_code>
<parameter=code>
from hermes_tools import write_file

content = r'''# Virtualobby — Implementation Plan (Revised v2)

> AssemblyAI Voice Agent Hackathon — Deadline: September 30, 2026
> Architecture: Cloudflare (Durable Objects + D1 + R2 + Pages + Workers)
> Voice: AssemblyAI Voice Agent API (browser-direct WebSocket)
> **v2:** Technical review fixes applied — see changelog at bottom

---

## 📋 Overview

**Goal:** A Telegram Mini App where visitors check in via voice + camera. The agent greets them, scans their ID, asks business-specific questions by voice, confirms, and registers.

**Current state:** ~70% built but fragmented. Worker deployed, Mini App exists, agent defined but not published. Need to refactor onto Durable Objects + D1 architecture.

### Revised Architecture Flow

```
User opens Telegram bot → Mini App loads
    ↓
Browser parses start_param to extract business_id
    ↓
Browser requests UUID-based session from Worker (GET /api/ws)
    → Worker generates UUID, creates DO instance <uuid>, returns UUID to browser
    ↓
Browser opens WebSocket to DO: /api/ws/<uuid>
    → First message: { "type": "start", "business_id": "clinic-main" }
    ↓
Browser requests session token from Worker (GET /api/token)
    → Worker proxies: GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60
    → Returns: { "token": "***" }
    ↓
Browser opens WebSocket to AssemblyAI: wss://agents.assemblyai.com/v1/ws?token=<token>
    ↓
DO loads business config from D1, sends welcome text to browser
AssemblyAI plays greeting voice
    ↓
Voice conversation: user speaks → AssemblyAI transcribes →
browser sends USER_TRANSCRIPT text to DO
    ↓
DO FSM: greeting → questions (loop) → camera scan → confirm → done
    ↓
Camera capture → presigned R2 upload → R2 key sent to DO → Vision API → OCR data
    ↓
DO saves everything to D1 guest_registrations
    ↓
CHECKIN_COMPLETE sent to browser + AssemblyAI speaks confirmation
```

### Key Architectural Decisions (Revised)

| Decision | Old | New | Rationale |
|----------|-----|-----|-----------|
| Session table | D1 `sessions` table | DO in-memory state | Simpler; DO already manages lifecycle |
| Voice relay | DO relays audio browser↔AssemblyAI | Browser connects to AssemblyAI directly | Lower latency, simpler DO, no audio in DO |
| OCR engine | Tesseract.js (client-side) | Vision model (Workers AI or external API) | Better accuracy, no 2MB WASM download |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS | Higher quality, consistent voice (AssemblyAI voice IDs only) |
| Admin dashboard | (implied framework) | Vanilla HTML/JS, fetch() to Worker API | No build step, fast to ship for hackathon |
| D1 tables | 4 tables | 3 tables (no sessions) | DO manages session state in memory |
| DO key | Per-business (`/api/ws/:businessId`) | Per-visitor UUID (`/api/ws/<uuid>`) | Prevents state collision between concurrent visitors |
| Image upload | base64 over WebSocket | Presigned R2 URL (browser→R2 direct) | 2-6MB base64 exceeds WS frame limits |
| Session token | `POST /v2/voice-agent/session` (wrong) | `GET agents.assemblyai.com/v1/token?product=voice_agent` | Correct documented endpoint |
| Voice persona | `"alloy"` (OpenAI voice) | `"anna"` (AssemblyAI voice) | Only AssemblyAI voice IDs are valid |

---

## Security Notes

> **Apply before any deployment.**

1. **API keys as Wrangler secrets** — `ASSEMBLYAI_API_KEY` and `AGENT_ID` must be stored as Wrangler secrets, NOT in `wrangler.toml` [vars]:
   ```bash
   wrangler secret put ASSEMBLYAI_API_KEY
   wrangler secret put AGENT_ID
   ```
2. **CORS headers** — All Worker API endpoints (`/api/*`) must return appropriate `Access-Control-Allow-Origin` headers. For Telegram Mini Apps, the origin is the Telegram WebView domain. Use `*` during development, restrict in production.
3. **initData validation** — Admin endpoints must validate `Telegram.WebApp.initData` using the bot token HMAC to prevent spoofed admin requests.

---

## Phase 1: Foundation (Days 1-2)

### 1.1 — D1 Database Schema
**Effort:** 1-2h | **Blocks:** 1.2, 1.3, 2.1

Create D1 database and define schema with **3 tables**.

**Files to create:** `schema.sql` and `seed.sql` (for reproducibility — judges clone and run).

```sql
-- schema.sql
-- Businesses (admin-managed)
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,                          -- e.g. "clinic-main"
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,                  -- clinic | lawyer | hotel | office
  welcome_message TEXT DEFAULT 'Welcome! I will help you check in.',
  voice_persona TEXT DEFAULT 'anna',            -- AssemblyAI voice ID (NOT OpenAI)
  requires_id_scan INTEGER DEFAULT 1,           -- 1 = prompt for ID scan, 0 = skip
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Business-specific questions (questionnaire template)
CREATE TABLE business_questions (
  id TEXT PRIMARY KEY,                          -- e.g. "q-clinic-appointment"
  business_id TEXT NOT NULL,                    -- FK → businesses.id
  field_key TEXT NOT NULL,                      -- e.g. "appointment", "purpose"
  question_text TEXT NOT NULL,                  -- e.g. "Do you have an appointment?"
  order_index INTEGER NOT NULL,                 -- question sequence
  validation_type TEXT DEFAULT 'text',          -- text | yes_no | number | date | email
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Guest registrations (final records)
CREATE TABLE guest_registrations (
  id TEXT PRIMARY KEY,                          -- UUID (crypto.randomUUID())
  business_id TEXT NOT NULL,                    -- FK → businesses.id
  answers_json TEXT,                            -- JSON: {"appointment": "yes", ...}
  ocr_data_json TEXT,                           -- JSON: {"name": "...", "id_number": "...", ...}
  id_image_r2_key TEXT,                         -- R2 path for document photo
  status TEXT DEFAULT 'completed',              -- completed | partial | error
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);
```

**Commands:**
```bash
cd ~/intakeai
wrangler d1 create virtualobby-db
# Note the output ID, add to wrangler.toml:
# [[d1_databases]]
# binding = "DB"
# database_name = "virtualobby-db"
# database_id = "<returned-id>"
```

**Acceptance:** Tables created, `wrangler d1 execute virtualobby-db --command "SELECT name FROM sqlite_master WHERE type='table'"` returns `businesses`, `business_questions`, `guest_registrations` (3 tables). Verify with `PRAGMA table_info(businesses)` etc. `schema.sql` and `seed.sql` files exist in repo root.

---

### 1.2 — R2 Bucket for Document Photos
**Effort:** 15min | **Blocks:** 2.3

```bash
wrangler r2 bucket create virtualobby-docs
# Add to wrangler.toml:
# [[r2_buckets]]
# binding = "R2_DOCS"
# bucket_name = "virtualobby-docs"
```

**Acceptance:** `wrangler r2 bucket list` shows `virtualobby-docs`.

---

### 1.3 — Seed Data
**Effort:** 30min | **Blocks:** 2.1

Insert default business + questions via D1. Also create `seed.sql` for reproducibility.

**File:** `seed.sql`

```sql
INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan)
VALUES ('clinic-main', 'Demo Clinic', 'clinic', 'Welcome to Demo Clinic! I will help you check in for your visit.', 'anna', 1);

INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES
  ('q-apt-1', 'clinic-main', 'appointment', 'Do you have an appointment today?', 1, 'yes_no'),
  ('q-apt-2', 'clinic-main', 'doctor_name', 'Which doctor are you visiting?', 2, 'text'),
  ('q-apt-3', 'clinic-main', 'reason', 'What is the reason for your visit?', 3, 'text'),
  ('q-apt-4', 'clinic-main', 'insurance', 'Do you have insurance?', 4, 'yes_no'),
  ('q-apt-5', 'clinic-main', 'emergency_contact', 'What is your emergency contact phone number?', 5, 'text');
```

Run via:
```bash
wrangler d1 execute virtualobby-db --file ./seed.sql
```

**Acceptance:** `SELECT * FROM businesses` and `SELECT * FROM business_questions WHERE business_id = 'clinic-main'` return data. `seed.sql` exists in repo root.

---

### 1.4 — Publish AssemblyAI Agent
**Effort:** 30min | **Blocks:** 2.4

```bash
cd ~/intakeai
# Ensure .env has ASSEMBLYAI_API_KEY
python publish.py  # publishes agents/intake-clinic.jsonc
# Save the returned AGENT_ID
```

**Acceptance:** Agent appears in AssemblyAI dashboard, agent_id saved in `.env`. Store as Wrangler secret:
```bash
wrangler secret put AGENT_ID
```

---

### 1.5 — AssemblyAI Session Token Endpoint (CORRECTED)
**Effort:** 1-2h | **Blocks:** 2.4
**Dependencies:** 1.4

**File:** `api/worker.js` (new route)

The browser needs a temporary token to connect directly to the AssemblyAI Voice Agent WebSocket. The Worker mints this token server-side (keeping the API key secret).

**Endpoint:** `GET /api/token` (proxies AssemblyAI's token endpoint)

> **⚠️ REVIEW FIX:** The previous plan used `POST /v2/voice-agent/session` — that endpoint does not exist. The correct flow (from working `deployment/browser/server.py`) is:
> - Worker proxies: `GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60`
> - Returns: `{ "token": "***" }`
> - Browser constructs: `wss://agents.assemblyai.com/v1/ws?token=<token>`

```javascript
// In api/worker.js
async function handleSessionToken(env) {
  const resp = await fetch(
    'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60',
    {
      headers: {
        'Authorization': `Bearer ${env.ASSEMBLYAI_API_KEY}`,
      },
    }
  );
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: 'Failed to mint token' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const data = await resp.json();
  // Return the token — browser will construct: wss://agents.assemblyai.com/v1/ws?token=<token>
  return new Response(JSON.stringify({ token: data.token }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

**Acceptance:**
- `curl /api/token` returns `{ "token": "***" }`.
- Token is never exposed in client-side source code.
- Browser uses `wss://agents.assemblyai.com/v1/ws?token=<token>` to connect.

---

## Phase 2: Core Implementation (Days 3-5)

### 2.1 — Durable Object: CheckinSession
**Effort:** 4-6h | **Blocks:** 2.2, 2.3, 2.4
**Dependencies:** 1.1

**File:** `api/checkin-do.js`

**CRITICAL: The DO does NOT relay audio. The DO does NOT connect to AssemblyAI.**
The DO ONLY manages: FSM state machine + D1 queries + R2 storage.
The browser connects to AssemblyAI directly for voice/audio.

**CRITICAL: Each visitor gets their own DO instance (UUID-based), NOT per-business.**

> **⚠️ REVIEW FIX:** The previous plan used `/api/ws/:businessId` as the DO key, which meant all visitors to the same business shared one DO instance — causing state collision. The fix:
> - Worker generates UUID per session: `crypto.randomUUID()`
> - DO key is the UUID, not the business ID
> - Business ID is passed as the first WebSocket message after connect

FSM states:
```
idle → greeting → asking_questions (loops) → scanning_doc → confirming → done
```

Key responsibilities:
- `webSocketOpen()` — Wait for `start` message with `business_id`
- First `webSocketMessage({ type: "start", business_id })` — Read business config from D1, send welcome text to browser
- `webSocketMessage()` — Process incoming TEXT messages (commands, transcripts from browser, R2 keys for OCR)
- `webSocketClose()` — Clean up in-memory state
- `alarm()` — Session timeout (auto-close after 10min idle)
- State transitions with validation (can't jump from greeting to done)
- Store partial answers in `this.state` (in-memory during session)
- On `confirmed`: write to D1 `guest_registrations` table with `crypto.randomUUID()` for the registration ID

**In-memory state shape:**
```javascript
this.state = {
  businessId: null,        // set on "start" message
  fsmState: 'idle',
  businessConfig: { /* from D1 */ },
  questions: [ /* from D1 business_questions */ ],
  currentQuestionIndex: 0,
  answers: {},
  ocrData: null,
  idImageR2Key: null,
  startedAt: Date.now(),
};
```

Message protocol (browser ↔ DO):
```json
// Browser → DO
{ "type": "start", "business_id": "clinic-main" }
{ "type": "user_transcript", "text": "yes I have an appointment" }
{ "type": "id_uploaded", "r2_key": "ids/clinic-main/abc123.jpg" }
{ "type": "confirm" }

// DO → Browser
{ "type": "welcome", "text": "Welcome to Demo Clinic! I will help you check in.", "voice_persona": "anna" }
{ "type": "state", "state": "asking_questions", "question": "Do you have an appointment today?" }
{ "type": "ocr_result", "fields": { "name": "Alejandro", "id_number": "12345678" } }
{ "type": "summary", "answers": { "appointment": "yes", "doctor_name": "Smith" }, "ocr": { "name": "Alejandro" } }
{ "type": "checkin_complete", "registration_id": "uuid-here" }
{ "type": "error", "message": "..." }
```

D1 writes on confirm:
```javascript
// registration ID generated via crypto.randomUUID()
await env.DB.prepare(
  'INSERT INTO guest_registrations (id, business_id, answers_json, ocr_data_json, id_image_r2_key, status) VALUES (?, ?, ?, ?, ?, ?)'
).bind(crypto.randomUUID(), this.state.businessId, JSON.stringify(this.state.answers), JSON.stringify(this.state.ocrData), this.state.idImageR2Key, 'completed').run();
```

**Acceptance:** DO handles concurrent visitors without state collision. Each visitor gets isolated state in their own DO instance.

---

### 2.2 — Worker Router (API Layer)
**Effort:** 3-4h | **Blocks:** 2.3, 2.4
**Dependencies:** 2.1

**File:** `api/worker.js`

Routes:
```
GET  /api/token              → Mint AssemblyAI session token (see 1.5)
GET  /api/ws                 → Generate UUID, create DO instance, return UUID to browser
GET  /api/ws/:uuid           → WebSocket upgrade to DO instance <uuid>
GET  /api/upload-url         → Generate presigned R2 PUT URL for image upload
GET  /api/businesses         → List businesses (admin)
POST /api/businesses         → Create business (admin)
GET  /api/businesses/:id     → Get business config
GET  /api/businesses/:id/registrations → List registrations (admin)
```

> **⚠️ REVIEW FIX:** DO routing changed from `/api/ws/:businessId` to UUID-based. The Worker generates the UUID and creates the DO instance.

**Session creation flow (Worker):**
```javascript
// GET /api/ws — Worker generates UUID and returns it
async function handleNewSession(env) {
  const sessionId = crypto.randomUUID();
  // The DO instance is created on first connect via idFromName(sessionId)
  return new Response(JSON.stringify({ session_id: sessionId }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// GET /api/ws/:uuid — WebSocket upgrade to DO
async function handleWSConnect(env, uuid) {
  const doId = env.CHECKIN_DO.idFromName(uuid);
  const stub = env.CHECKIN_DO.get(doId);
  return stub.fetch(request);  // forward the WS upgrade
}
```

**Presigned upload flow (Worker):**
```javascript
// GET /api/upload-url — Generate presigned R2 PUT URL
async function handleUploadUrl(env, request) {
  const key = 'ids/' + crypto.randomUUID() + '.jpg';
  const url = await env.R2_DOCS.createPresignedUrl(key, {
    method: 'PUT',
    expiresIn: 300, // 5 minutes
  });
  return new Response(JSON.stringify({ upload_url: url, r2_key: key }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

> **⚠️ REVIEW FIX:** All API responses include CORS headers. Admin endpoints validate `Telegram.WebApp.initData` HMAC.

**Acceptance:** `GET /api/ws` returns `{ "session_id": "<uuid>" }`. `GET /api/token` returns token. `GET /api/upload-url` returns presigned URL and key. All endpoints have CORS headers.

---

### 2.3 — Frontend Refactor (Telegram Mini App)
**Effort:** 4-6h | **Blocks:** 2.5
**Dependencies:** 2.2, 1.2

**Files:** `telegram/webapp/index.html`, `app.js`, `style.css`

Major changes:
- **Remove** Tesseract.js OCR entirely (OCR now server-side via Vision model)
- **Add** Telegram `start_param` parsing to extract business ID
- **Add** WebSocket connection to DO via Worker (UUID-based, for state management)
- **Add** WebSocket connection to AssemblyAI Voice Agent (for voice/audio)
- **Add** session token fetch: `GET /api/token` → get token → connect to `wss://agents.assemblyai.com/v1/ws?token=<token>`
- **Add** presigned R2 upload for ID photos (instead of base64 over WebSocket)
- **Remove** all Web Speech API usage (TTS now handled by AssemblyAI native TTS)
- **Simplify** UI to voice-first: big mic button, transcript display, status indicator

> **⚠️ REVIEW FIX:** Telegram `start_param` parsing (was missing):
```javascript
// Parse Telegram start_param to extract business ID
// Format: start_param = "business_clinic-main" -> extract "clinic-main"
const tg = window.Telegram && window.Telegram.WebApp;
const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
const businessId = startParam.startsWith('business_')
  ? startParam.replace('business_', '')
  : 'clinic-main'; // fallback default
```

> **⚠️ REVIEW FIX:** UUID-based DO connection (was businessId-based):
```javascript
// 1. Request session from Worker (returns UUID)
const sessionResp = await fetch('/api/ws');
const { session_id } = await sessionResp.json();

// 2. Connect to DO via UUID
const doWs = new WebSocket('wss://' + location.host + '/api/ws/' + session_id);

// 3. Send business_id as first message after connect
doWs.onopen = () => {
  doWs.send(JSON.stringify({ type: 'start', business_id: businessId }));
};
```

> **⚠️ REVIEW FIX:** Correct AssemblyAI token flow (was using wrong endpoint):
```javascript
// 4. Connect to AssemblyAI for voice (correct endpoint)
const tokenResp = await fetch('/api/token');
const { token } = await tokenResp.json();
const assemblyWs = new WebSocket('wss://agents.assemblyai.com/v1/ws?token=' + token);
```

> **⚠️ REVIEW FIX:** Presigned R2 upload for ID images (was base64 over WebSocket):
```javascript
// 5. Image upload via presigned R2 URL (NOT base64 over WebSocket)
async function uploadIdImage(file) {
  // Get presigned URL from Worker
  const resp = await fetch('/api/upload-url');
  const { upload_url, r2_key } = await resp.json();

  // Upload directly to R2
  await fetch(upload_url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'image/jpeg' },
  });

  // Send only the R2 key to DO (not the image data)
  doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key: r2_key }));
}
```

```javascript
// 6. When AssemblyAI transcribes user speech, forward to DO
assemblyWs.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'final_transcript') {
    doWs.send(JSON.stringify({ type: 'user_transcript', text: msg.text }));
  }
};
```

UI flow:
1. Open → parse `start_param` → request session UUID → connect DO WS → send `start` with `business_id` → fetch token → connect AssemblyAI WS → DO sends welcome text → AssemblyAI speaks greeting
2. Voice conversation: user speaks → AssemblyAI transcribes → browser forwards transcript to DO → DO sends next question → AssemblyAI speaks question
3. Document scan → DO sends `{ type: "scan_prompt" }` → camera opens → photo captured → presigned upload to R2 → R2 key sent to DO → DO calls Vision API → sends OCR result back
4. Questions loop → agent speaks question → user answers by voice → transcript shown → DO processes → next question
5. Summary → DO sends all answers + OCR data → agent reads back → user confirms by voice or tap
6. Done → `checkin_complete` → show confirmation + "You're checked in"

> **⚠️ REVIEW FIX:** Test dual-WS in Telegram WebView early on **Day 2** (not Day 5) to catch compatibility issues before investing in the full stack.

**Acceptance:** Can open Mini App, see greeting, hear voice, speak and get transcribed, receive questions by voice, camera works for ID scan. ID image uploads via presigned URL, not base64.

---

### 2.4 — AssemblyAI Browser Connection (REVISED)
**Effort:** 2-3h | **Blocks:** 2.5
**Dependencies:** 1.4, 1.5, 2.3

**This task is simpler than the original 2.4** because the browser connects to AssemblyAI directly — the DO does NOT relay audio.

**What this task covers:**
1. Wire up session token flow: browser calls `GET /api/token` → receives token → opens WebSocket to `wss://agents.assemblyai.com/v1/ws?token=<token>`
2. Configure AssemblyAI agent with `voice_persona` from business config (use AssemblyAI voice IDs only: `anna`, `michael`, `george`, `mary`, `eve`, `paul`, `jane`, etc. — see [voice catalog](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices))
3. Handle AssemblyAI WebSocket events in the browser:
   - `session_started` → ready
   - `transcript` (partial/final) → display in UI + forward final to DO
   - `agent_audio` → play through AudioContext (AssemblyAI handles TTS)
   - `error` → reconnect logic
4. Pass business-specific greeting to AssemblyAI so it speaks the correct welcome message
5. When DO sends a question text to the browser, the browser needs AssemblyAI to speak it:
   - Option A: Use AssemblyAI's `send_text` or `generate_reply` API to inject text for the agent to speak
   - Option B: The AssemblyAI agent is configured as a tool-calling agent that calls back to a Worker endpoint for the current question text (HTTP tool)

**Recommended approach:** The AssemblyAI agent uses HTTP tools to call the Worker for the current question/context. The Worker reads from the DO's state. This keeps the agent self-directed.

```
AssemblyAI agent HTTP tool: GET /api/context/:sessionId
  → Returns: { "current_question": "Do you have an appointment?", "state": "asking_questions", ... }
```

This way AssemblyAI's LLM naturally asks the right question, the browser doesn't need to inject text, and the voice conversation feels natural.

**Acceptance:**
- Browser opens WebSocket to AssemblyAI using minted token (`wss://agents.assemblyai.com/v1/ws?token=...`).
- Voice conversation works: user speaks, agent responds.
- Agent asks the correct business questions from D1 (via HTTP tool callback).
- Transcripts flow: AssemblyAI → browser → DO.

---

### 2.5 — End-to-End Integration Test
**Effort:** 2-3h | **Blocks:** 3.1
**Dependencies:** 2.3, 2.4

Test script:
1. Open `@Virtu_intake_bot` in Telegram
2. Tap "Open Virtualobby"
3. App loads, parses `start_param`, requests session UUID, connects both WebSockets
4. Agent greets by voice: "Welcome to Demo Clinic! I will help you check in."
5. User speaks: "Yes I have an appointment" → transcript appears, DO advances state
6. Agent asks next question by voice
7. User answers all questions by voice
8. Agent asks to scan ID → camera opens → photo taken → uploaded via presigned R2 URL → OCR results shown
9. Agent reads back summary → user confirms
10. "You're checked in!" → data in D1

**Acceptance:** Full flow works end-to-end. Two concurrent visitors to the same business get isolated sessions (no state collision).

---

## Phase 3: Polish & Demo Prep (Days 6-7)

### 3.1 — Multi-language Support
**Effort:** 2-3h | **Dependencies:** 2.5

- AssemblyAI Voice Agent handles multi-language natively (auto-detect)
- Business config: add `language` field to D1 businesses table
- Update agent system prompt to respond in detected language
- Add language indicator in UI

**Acceptance:** Same flow works in English and Spanish.

---

### 3.2 — Admin Panel
**Effort:** 3-4h | **Dependencies:** 2.2

**File:** `telegram/webapp/admin.html` (vanilla HTML/JS, no build step)

Features:
- View businesses list
- Add/edit business (name, welcome message, voice_persona, requires_id_scan)
- View questions per business (add/edit/reorder)
- View registrations per business (read-only table)
- Generate QR codes per business

> **⚠️ REVIEW FIX:** Admin endpoints validate `Telegram.WebApp.initData` HMAC using bot token to prevent spoofed requests. Admin page parses `initDataUnsafe.user.id` and checks against allowed admin IDs.

**Acceptance:** Admin can create a new business, add questions, view registrations, generate QR code.

---

### 3.3 — Error Handling & Edge Cases
**Effort:** 2-3h | **Dependencies:** 2.5

Handle:
- **WebSocket disconnect** (DO or AssemblyAI) → auto-reconnect (3 attempts), then show error
- **Session token expired** (60s) → re-fetch from `/api/token`, reconnect AssemblyAI WS
- **Session timeout** (10min idle via DO alarm) → save partial data to D1 (status: 'partial'), notify user
- **Audio not supported** → fallback to text input field, send as `user_transcript`
- **Camera denied** → skip document scan (`requires_id_scan=0` or manual skip), ask info verbally
- **Vision API failure** → fall back to asking user to describe their document verbally
- **AssemblyAI rate limit** → exponential backoff on token requests
- **Presigned URL expired** → re-request from `/api/upload-url`

**Acceptance:** App doesn't crash on any of the above scenarios. Graceful degradation in all cases.

---

### 3.4 — QR Code & Business Onboarding
**Effort:** 1h | **Dependencies:** 3.2

- Generate QR code per business: `https://t.me/Virtu_intake_bot?start=business_<id>`
- Simple admin flow to add new business + questions (via admin.html)
- New business gets default welcome message and 0 questions (admin adds them)

**Acceptance:** Scan QR → opens Telegram bot → correct business pre-selected via `start_param`. Admin can add a new business from the admin panel.

---

## Phase 4: Demo & Submission (Days 8-9)

### 4.1 — Demo Video
**Effort:** 3-4h | **Dependencies:** 3.1

Script:
1. **Hook (10s):** "What if your phone WAS the reception desk?"
2. **Problem (15s):** Long waits, paper forms, language barriers
3. **Solution (30s):** Open Telegram → voice check-in → done in 90 seconds
4. **Tech (20s):** AssemblyAI Voice Agent API + Cloudflare Durable Objects
5. **Live demo (45s):** Full check-in flow on a real phone (voice + camera)
6. **Multi-language (15s):** Same flow in Spanish
7. **Close (10s):** "Virtualobby — your phone is the reception desk"

**Acceptance:** 2-3 minute video, clear audio, real device footage.

---

### 4.2 — Submission Package
**Effort:** 1-2h | **Dependencies:** 4.1

- GitHub repo clean and documented
- README with architecture diagram, setup instructions, demo link
- Environment variables documented in `.env.example`
- Demo URL live and stable
- `schema.sql` and `seed.sql` for reproducibility

**Acceptance:** Judge can clone repo, follow README, run locally.

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | ~~AssemblyAI session token endpoint wrong~~ | ~~Critical~~ | ~~—~~ | **FIXED v2:** Corrected to `GET agents.assemblyai.com/v1/token?product=voice_agent`. Verified against working `deployment/browser/server.py`. |
| 2 | ~~DO state collision (per-business key)~~ | ~~Critical~~ | ~~—~~ | **FIXED v2:** UUID-based DO instances. Each visitor gets isolated DO. |
| 3 | ~~Voice persona "alloy" (OpenAI, not AssemblyAI)~~ | ~~High~~ | ~~—~~ | **FIXED v2:** Changed to `"anna"` (AssemblyAI voice). All voice_persona values must use AssemblyAI voice catalog. |
| 4 | ~~Base64 images over WebSocket (2-6MB)~~ | ~~High~~ | ~~—~~ | **FIXED v2:** Presigned R2 URL upload. Browser uploads directly to R2, sends only key to DO. |
| 5 | Browser can't maintain two WebSocket connections simultaneously | **High** | Low | Both are standard WS; Telegram Mini App WebView supports it. **Test on Day 2** (not Day 5) to catch early. |
| 6 | Vision model OCR quality insufficient | **Medium** | Medium | Test with `@cf/meta/llama-3.2-11b-vision` early; fall back to external API (OpenAI Vision) if Workers AI accuracy is poor. |
| 7 | AssemblyAI agent can't ask dynamic questions via HTTP tools | **Medium** | Medium | Fallback: browser injects question text into AssemblyAI via `send_text` API. Test HTTP tool approach first. |
| 8 | D1 cold start latency causes slow greeting | **Low** | Low | Pre-warm with health check endpoint. Business config rarely changes, consider caching. |
| 9 | DO in-memory state lost on restart | **Medium** | Low | Re-read business config from D1 on reconnect. Partial answers are ephemeral by design (short sessions). |
| 10 | Telegram WebView limits (camera, microphone) | **Medium** | Low | Telegram Mini Apps support both. Test on real device in Phase 2. |
| 11 | API keys in wrangler.toml [vars] exposed | **Medium** | Low | **FIXED v2:** Use Wrangler secrets for `ASSEMBLYAI_API_KEY` and `AGENT_ID`. |
| 12 | Presigned URL expires before upload completes | **Low** | Low | 5-minute expiry is generous. Frontend re-requests if expired. |

---

## File Structure (Target)

```
intakeai/
├── agents/
│   └── intake-clinic.jsonc          # AssemblyAI agent definition (voice_id: "anna")
├── api/
│   ├── worker.js                    # Router + REST endpoints + token proxy + presigned URLs
│   ├── checkin-do.js                # Durable Object (FSM + D1/R2, UUID-based, NO audio relay)
│   └── data/
│       └── submissions.json         # Legacy (remove after D1 migration — no data to migrate)
├── telegram/
│   └── webapp/
│       ├── index.html               # Main Mini App (dual WS: DO + AssemblyAI)
│       ├── app.js                   # Frontend logic (WS management + presigned upload + start_param parsing)
│       ├── style.css                # Mobile-first styles
│       ├── admin.html               # Admin panel (vanilla HTML/JS, fetch() only, initData HMAC validation)
│       └── visit.html               # Visit summary
├── deployment/
│   └── browser/                     # AssemblyAI browser deployment (reference)
├── wrangler.toml                    # CF config (Worker + D1 + R2 + DO). NO secrets in [vars].
├── schema.sql                       # D1 schema (3 tables, for reproducibility)
├── seed.sql                         # D1 seed data
├── publish.py                       # AssemblyAI agent publisher
├── lib.py                           # Shared Python utils
└── README.md
```

---

## Summary of Changes from Original Plan

| Area | Original Plan | Revised Plan |
|------|--------------|--------------|
| D1 Schema | 4 tables (businesses, questionnaires, submissions, sessions) | 3 tables (businesses, business_questions, guest_registrations). No sessions table. |
| Voice Architecture | DO relays audio browser↔AssemblyAI (Option A) | Browser connects to AssemblyAI directly. DO receives text transcripts only. |
| DO responsibilities | FSM + audio relay + D1 + R2 | FSM + D1 queries + R2 storage. NO audio. |
| OCR | Tesseract.js client-side | Vision model server-side (Workers AI or external API) |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS |
| Admin Dashboard | (implied React/framework) | Vanilla HTML/JS, fetch() to Worker API |
| Session Token | Not addressed | Worker proxies `GET agents.assemblyai.com/v1/token` (corrected from wrong endpoint) |
| Task 2.4 | "AssemblyAI Voice Agent ↔ DO Integration" (complex relay) | "AssemblyAI Browser Connection" (simpler, browser-direct) |
| Schema field names | `type`, `config JSON`, `question_type` | `business_type`, `welcome_message`, `voice_persona`, `requires_id_scan`, `field_key`, `validation_type` |
| DO<tool_call>
<function=execute_code>
<parameter=code>
from hermes_tools import terminal

# Write the entire file using Python via terminal, avoiding the content size limit
# by building it in a Python script that writes directly to disk

script = r'''
import json, os

content = """# Virtualobby — Implementation Plan (Revised v2)

> AssemblyAI Voice Agent Hackathon — Deadline: September 30, 2026
> Architecture: Cloudflare (Durable Objects + D1 + R2 + Pages + Workers)
> Voice: AssemblyAI Voice Agent API (browser-direct WebSocket)
> **v2:** Technical review fixes applied — see changelog at bottom

---

## 📋 Overview

**Goal:** A Telegram Mini App where visitors check in via voice + camera. The agent greets them, scans their ID, asks business-specific questions by voice, confirms, and registers.

**Current state:** ~70% built but fragmented. Worker deployed, Mini App exists, agent defined but not published. Need to refactor onto Durable Objects + D1 architecture.

### Revised Architecture Flow

```
User opens Telegram bot → Mini App loads
    ↓
Browser parses start_param to extract business_id
    ↓
Browser requests UUID-based session from Worker (GET /api/ws)
    → Worker generates UUID, creates DO instance <uuid>, returns UUID to browser
    ↓
Browser opens WebSocket to DO: /api/ws/<uuid>
    → First message: { "type": "start", "business_id": "clinic-main" }
    ↓
Browser requests session token from Worker (GET /api/token)
    → Worker proxies: GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60
    → Returns: { "token": "***" }
    ↓
Browser opens WebSocket to AssemblyAI: wss://agents.assemblyai.com/v1/ws?token=<token>
    ↓
DO loads business config from D1, sends welcome text to browser
AssemblyAI plays greeting voice
    ↓
Voice conversation: user speaks → AssemblyAI transcribes →
browser sends USER_TRANSCRIPT text to DO
    ↓
DO FSM: greeting → questions (loop) → camera scan → confirm → done
    ↓
Camera capture → presigned R2 upload → R2 key sent to DO → Vision API → OCR data
    ↓
DO saves everything to D1 guest_registrations
    ↓
CHECKIN_COMPLETE sent to browser + AssemblyAI speaks confirmation
```

### Key Architectural Decisions (Revised)

| Decision | Old | New | Rationale |
|----------|-----|-----|-----------|
| Session table | D1 `sessions` table | DO in-memory state | Simpler; DO already manages lifecycle |
| Voice relay | DO relays audio browser↔AssemblyAI | Browser connects to AssemblyAI directly | Lower latency, simpler DO, no audio in DO |
| OCR engine | Tesseract.js (client-side) | Vision model (Workers AI or external API) | Better accuracy, no 2MB WASM download |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS | Higher quality, consistent voice (AssemblyAI voice IDs only) |
| Admin dashboard | (implied framework) | Vanilla HTML/JS, fetch() to Worker API | No build step, fast to ship for hackathon |
| D1 tables | 4 tables | 3 tables (no sessions) | DO manages session state in memory |
| DO key | Per-business (`/api/ws/:businessId`) | Per-visitor UUID (`/api/ws/<uuid>`) | Prevents state collision between concurrent visitors |
| Image upload | base64 over WebSocket | Presigned R2 URL (browser→R2 direct) | 2-6MB base64 exceeds WS frame limits |
| Session token | `POST /v2/voice-agent/session` (wrong) | `GET agents.assemblyai.com/v1/token?product=voice_agent` | Correct documented endpoint |
| Voice persona | `"alloy"` (OpenAI voice) | `"anna"` (AssemblyAI voice) | Only AssemblyAI voice IDs are valid |

---

## Security Notes

> **Apply before any deployment.**

1. **API keys as Wrangler secrets** — `ASSEMBLYAI_API_KEY` and `AGENT_ID` must be stored as Wrangler secrets, NOT in `wrangler.toml` [vars]:
   ```bash
   wrangler secret put ASSEMBLYAI_API_KEY
   wrangler secret put AGENT_ID
   ```
2. **CORS headers** — All Worker API endpoints (`/api/*`) must return appropriate `Access-Control-Allow-Origin` headers. For Telegram Mini Apps, the origin is the Telegram WebView domain. Use `*` during development, restrict in production.
3. **initData validation** — Admin endpoints must validate `Telegram.WebApp.initData` using the bot token HMAC to prevent spoofed admin requests.

---

## Phase 1: Foundation (Days 1-2)

### 1.1 — D1 Database Schema
**Effort:** 1-2h | **Blocks:** 1.2, 1.3, 2.1

Create D1 database and define schema with **3 tables**.

**Files to create:** `schema.sql` and `seed.sql` (for reproducibility — judges clone and run).

```sql
-- schema.sql
-- Businesses (admin-managed)
CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  welcome_message TEXT DEFAULT 'Welcome! I will help you check in.',
  voice_persona TEXT DEFAULT 'anna',
  requires_id_scan INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Business-specific questions (questionnaire template)
CREATE TABLE business_questions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  validation_type TEXT DEFAULT 'text',
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Guest registrations (final records)
CREATE TABLE guest_registrations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  answers_json TEXT,
  ocr_data_json TEXT,
  id_image_r2_key TEXT,
  status TEXT DEFAULT 'completed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);
```

**Commands:**
```bash
cd ~/intakeai
wrangler d1 create virtualobby-db
# Note the output ID, add to wrangler.toml:
# [[d1_databases]]
# binding = "DB"
# database_name = "virtualobby-db"
# database_id = "<returned-id>"
```

**Acceptance:** Tables created, `wrangler d1 execute virtualobby-db --command "SELECT name FROM sqlite_master WHERE type='table'"` returns `businesses`, `business_questions`, `guest_registrations` (3 tables). Verify with `PRAGMA table_info(businesses)` etc. `schema.sql` and `seed.sql` files exist in repo root.

---

### 1.2 — R2 Bucket for Document Photos
**Effort:** 15min | **Blocks:** 2.3

```bash
wrangler r2 bucket create virtualobby-docs
# Add to wrangler.toml:
# [[r2_buckets]]
# binding = "R2_DOCS"
# bucket_name = "virtualobby-docs"
```

**Acceptance:** `wrangler r2 bucket list` shows `virtualobby-docs`.

---

### 1.3 — Seed Data
**Effort:** 30min | **Blocks:** 2.1

Insert default business + questions via D1. Also create `seed.sql` for reproducibility.

**File:** `seed.sql`

```sql
INSERT INTO businesses (id, name, business_type, welcome_message, voice_persona, requires_id_scan)
VALUES ('clinic-main', 'Demo Clinic', 'clinic', 'Welcome to Demo Clinic! I will help you check in for your visit.', 'anna', 1);

INSERT INTO business_questions (id, business_id, field_key, question_text, order_index, validation_type) VALUES
  ('q-apt-1', 'clinic-main', 'appointment', 'Do you have an appointment today?', 1, 'yes_no'),
  ('q-apt-2', 'clinic-main', 'doctor_name', 'Which doctor are you visiting?', 2, 'text'),
  ('q-apt-3', 'clinic-main', 'reason', 'What is the reason for your visit?', 3, 'text'),
  ('q-apt-4', 'clinic-main', 'insurance', 'Do you have insurance?', 4, 'yes_no'),
  ('q-apt-5', 'clinic-main', 'emergency_contact', 'What is your emergency contact phone number?', 5, 'text');
```

Run via:
```bash
wrangler d1 execute virtualobby-db --file ./seed.sql
```

**Acceptance:** `SELECT * FROM businesses` and `SELECT * FROM business_questions WHERE business_id = 'clinic-main'` return data. `seed.sql` exists in repo root.

---

### 1.4 — Publish AssemblyAI Agent
**Effort:** 30min | **Blocks:** 2.4

```bash
cd ~/intakeai
# Ensure .env has ASSEMBLYAI_API_KEY
python publish.py  # publishes agents/intake-clinic.jsonc
# Save the returned AGENT_ID
```

**Acceptance:** Agent appears in AssemblyAI dashboard, agent_id saved in `.env`. Store as Wrangler secret:
```bash
wrangler secret put AGENT_ID
```

---

### 1.5 — AssemblyAI Session Token Endpoint (CORRECTED)
**Effort:** 1-2h | **Blocks:** 2.4
**Dependencies:** 1.4

**File:** `api/worker.js` (new route)

The browser needs a temporary token to connect directly to the AssemblyAI Voice Agent WebSocket. The Worker mints this token server-side (keeping the API key secret).

**Endpoint:** `GET /api/token` (proxies AssemblyAI's token endpoint)

> **⚠️ REVIEW FIX:** The previous plan used `POST /v2/voice-agent/session` — that endpoint does not exist. The correct flow (from working `deployment/browser/server.py`) is:
> - Worker proxies: `GET https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60`
> - Returns: `{ "token": "***" }`
> - Browser constructs: `wss://agents.assemblyai.com/v1/ws?token=<token>`

```javascript
// In api/worker.js
async function handleSessionToken(env) {
  const resp = await fetch(
    'https://agents.assemblyai.com/v1/token?product=voice_agent&expires_in_seconds=60',
    {
      headers: {
        'Authorization': `Bearer ${env.ASSEMBLYAI_API_KEY}`,
      },
    }
  );
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: 'Failed to mint token' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const data = await resp.json();
  return new Response(JSON.stringify({ token: data.token }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

**Acceptance:**
- `curl /api/token` returns `{ "token": "***" }`.
- Token is never exposed in client-side source code.
- Browser uses `wss://agents.assemblyai.com/v1/ws?token=<token>` to connect.

---

## Phase 2: Core Implementation (Days 3-5)

### 2.1 — Durable Object: CheckinSession
**Effort:** 4-6h | **Blocks:** 2.2, 2.3, 2.4
**Dependencies:** 1.1

**File:** `api/checkin-do.js`

**CRITICAL: The DO does NOT relay audio. The DO does NOT connect to AssemblyAI.**
The DO ONLY manages: FSM state machine + D1 queries + R2 storage.
The browser connects to AssemblyAI directly for voice/audio.

**CRITICAL: Each visitor gets their own DO instance (UUID-based), NOT per-business.**

> **⚠️ REVIEW FIX:** The previous plan used `/api/ws/:businessId` as the DO key, which meant all visitors to the same business shared one DO instance — causing state collision. The fix:
> - Worker generates UUID per session: `crypto.randomUUID()`
> - DO key is the UUID, not the business ID
> - Business ID is passed as the first WebSocket message after connect

FSM states:
```
idle → greeting → asking_questions (loops) → scanning_doc → confirming → done
```

Key responsibilities:
- `webSocketOpen()` — Wait for `start` message with `business_id`
- First `webSocketMessage({ type: "start", business_id })` — Read business config from D1, send welcome text to browser
- `webSocketMessage()` — Process incoming TEXT messages (commands, transcripts from browser, R2 keys for OCR)
- `webSocketClose()` — Clean up in-memory state
- `alarm()` — Session timeout (auto-close after 10min idle)
- State transitions with validation (can't jump from greeting to done)
- Store partial answers in `this.state` (in-memory during session)
- On `confirmed`: write to D1 `guest_registrations` table with `crypto.randomUUID()` for the registration ID

**In-memory state shape:**
```javascript
this.state = {
  businessId: null,        // set on "start" message
  fsmState: 'idle',
  businessConfig: { /* from D1 */ },
  questions: [ /* from D1 business_questions */ ],
  currentQuestionIndex: 0,
  answers: {},
  ocrData: null,
  idImageR2Key: null,
  startedAt: Date.now(),
};
```

Message protocol (browser <-> DO):
```json
// Browser -> DO
{ "type": "start", "business_id": "clinic-main" }
{ "type": "user_transcript", "text": "yes I have an appointment" }
{ "type": "id_uploaded", "r2_key": "ids/clinic-main/abc123.jpg" }
{ "type": "confirm" }

// DO -> Browser
{ "type": "welcome", "text": "Welcome to Demo Clinic! I will help you check in.", "voice_persona": "anna" }
{ "type": "state", "state": "asking_questions", "question": "Do you have an appointment today?" }
{ "type": "ocr_result", "fields": { "name": "Alejandro", "id_number": "12345678" } }
{ "type": "summary", "answers": { "appointment": "yes", "doctor_name": "Smith" }, "ocr": { "name": "Alejandro" } }
{ "type": "checkin_complete", "registration_id": "uuid-here" }
{ "type": "error", "message": "..." }
```

D1 writes on confirm:
```javascript
await env.DB.prepare(
  'INSERT INTO guest_registrations (id, business_id, answers_json, ocr_data_json, id_image_r2_key, status) VALUES (?, ?, ?, ?, ?, ?)'
).bind(crypto.randomUUID(), this.state.businessId, JSON.stringify(this.state.answers), JSON.stringify(this.state.ocrData), this.state.idImageR2Key, 'completed').run();
```

**Acceptance:** DO handles concurrent visitors without state collision. Each visitor gets isolated state in their own DO instance.

---

### 2.2 — Worker Router (API Layer)
**Effort:** 3-4h | **Blocks:** 2.3, 2.4
**Dependencies:** 2.1

**File:** `api/worker.js`

Routes:
```
GET  /api/token              -> Mint AssemblyAI session token (see 1.5)
GET  /api/ws                 -> Generate UUID, create DO instance, return UUID to browser
GET  /api/ws/:uuid           -> WebSocket upgrade to DO instance <uuid>
GET  /api/upload-url         -> Generate presigned R2 PUT URL for image upload
GET  /api/businesses         -> List businesses (admin)
POST /api/businesses         -> Create business (admin)
GET  /api/businesses/:id     -> Get business config
GET  /api/businesses/:id/registrations -> List registrations (admin)
```

> **⚠️ REVIEW FIX:** DO routing changed from `/api/ws/:businessId` to UUID-based. The Worker generates the UUID and creates the DO instance.

**Session creation flow (Worker):**
```javascript
// GET /api/ws — Worker generates UUID and returns it
async function handleNewSession(env) {
  const sessionId = crypto.randomUUID();
  return new Response(JSON.stringify({ session_id: sessionId }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// GET /api/ws/:uuid — WebSocket upgrade to DO
async function handleWSConnect(env, uuid, request) {
  const doId = env.CHECKIN_DO.idFromName(uuid);
  const stub = env.CHECKIN_DO.get(doId);
  return stub.fetch(request);
}
```

**Presigned upload flow (Worker):**
```javascript
// GET /api/upload-url — Generate presigned R2 PUT URL
async function handleUploadUrl(env) {
  const key = 'ids/' + crypto.randomUUID() + '.jpg';
  const url = await env.R2_DOCS.createPresignedUrl(key, {
    method: 'PUT',
    expiresIn: 300, // 5 minutes
  });
  return new Response(JSON.stringify({ upload_url: url, r2_key: key }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

> **⚠️ REVIEW FIX:** All API responses include CORS headers. Admin endpoints validate `Telegram.WebApp.initData` HMAC.

**Acceptance:** `GET /api/ws` returns `{ "session_id": "<uuid>" }`. `GET /api/token` returns token. `GET /api/upload-url` returns presigned URL and key. All endpoints have CORS headers.

---

### 2.3 — Frontend Refactor (Telegram Mini App)
**Effort:** 4-6h | **Blocks:** 2.5
**Dependencies:** 2.2, 1.2

**Files:** `telegram/webapp/index.html`, `app.js`, `style.css`

Major changes:
- **Remove** Tesseract.js OCR entirely (OCR now server-side via Vision model)
- **Add** Telegram `start_param` parsing to extract business ID
- **Add** WebSocket connection to DO via Worker (UUID-based, for state management)
- **Add** WebSocket connection to AssemblyAI Voice Agent (for voice/audio)
- **Add** session token fetch: `GET /api/token` -> get token -> connect to `wss://agents.assemblyai.com/v1/ws?token=<token>`
- **Add** presigned R2 upload for ID photos (instead of base64 over WebSocket)
- **Remove** all Web Speech API usage (TTS now handled by AssemblyAI native TTS)
- **Simplify** UI to voice-first: big mic button, transcript display, status indicator

> **⚠️ REVIEW FIX:** Telegram `start_param` parsing (was missing):
```javascript
// Parse Telegram start_param to extract business ID
// Format: start_param = "business_clinic-main" -> extract "clinic-main"
const tg = window.Telegram && window.Telegram.WebApp;
const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
const businessId = startParam.startsWith('business_')
  ? startParam.replace('business_', '')
  : 'clinic-main'; // fallback default
```

> **⚠️ REVIEW FIX:** UUID-based DO connection (was businessId-based):
```javascript
// 1. Request session from Worker (returns UUID)
const sessionResp = await fetch('/api/ws');
const { session_id } = await sessionResp.json();

// 2. Connect to DO via UUID
const doWs = new WebSocket('wss://' + location.host + '/api/ws/' + session_id);

// 3. Send business_id as first message after connect
doWs.onopen = () => {
  doWs.send(JSON.stringify({ type: 'start', business_id: businessId }));
};
```

> **⚠️ REVIEW FIX:** Correct AssemblyAI token flow (was using wrong endpoint):
```javascript
// 4. Connect to AssemblyAI for voice (correct endpoint)
const tokenResp = await fetch('/api/token');
const { token } = await tokenResp.json();
const assemblyWs = new WebSocket('wss://agents.assemblyai.com/v1/ws?token=' + token);
```

> **⚠️ REVIEW FIX:** Presigned R2 upload for ID images (was base64 over WebSocket):
```javascript
// 5. Image upload via presigned R2 URL (NOT base64 over WebSocket)
async function uploadIdImage(file) {
  const resp = await fetch('/api/upload-url');
  const { upload_url, r2_key } = await resp.json();
  await fetch(upload_url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  // Send only the R2 key to DO (not the image data)
  doWs.send(JSON.stringify({ type: 'id_uploaded', r2_key: r2_key }));
}
```

```javascript
// 6. When AssemblyAI transcribes user speech, forward to DO
assemblyWs.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'final_transcript') {
    doWs.send(JSON.stringify({ type: 'user_transcript', text: msg.text }));
  }
};
```

UI flow:
1. Open -> parse `start_param` -> request session UUID -> connect DO WS -> send `start` with `business_id` -> fetch token -> connect AssemblyAI WS -> DO sends welcome text -> AssemblyAI speaks greeting
2. Voice conversation: user speaks -> AssemblyAI transcribes -> browser forwards transcript to DO -> DO sends next question -> AssemblyAI speaks question
3. Document scan -> DO sends `{ type: "scan_prompt" }` -> camera opens -> photo captured -> presigned upload to R2 -> R2 key sent to DO -> DO calls Vision API -> sends OCR result back
4. Questions loop -> agent speaks question -> user answers by voice -> transcript shown -> DO processes -> next question
5. Summary -> DO sends all answers + OCR data -> agent reads back -> user confirms by voice or tap
6. Done -> `checkin_complete` -> show confirmation + "You're checked in"

> **⚠️ REVIEW FIX:** Test dual-WS in Telegram WebView early on **Day 2** (not Day 5) to catch compatibility issues before investing in the full stack.

**Acceptance:** Can open Mini App, see greeting, hear voice, speak and get transcribed, receive questions by voice, camera works for ID scan. ID image uploads via presigned URL, not base64.

---

### 2.4 — AssemblyAI Browser Connection (REVISED)
**Effort:** 2-3h | **Blocks:** 2.5
**Dependencies:** 1.4, 1.5, 2.3

**This task is simpler than the original 2.4** because the browser connects to AssemblyAI directly — the DO does NOT relay audio.

**What this task covers:**
1. Wire up session token flow: browser calls `GET /api/token` -> receives token -> opens WebSocket to `wss://agents.assemblyai.com/v1/ws?token=<token>`
2. Configure AssemblyAI agent with `voice_persona` from business config (use AssemblyAI voice IDs only: `anna`, `michael`, `george`, `mary`, `eve`, `paul`, `jane`, etc. — see [voice catalog](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices))
3. Handle AssemblyAI WebSocket events in the browser:
   - `session_started` -> ready
   - `transcript` (partial/final) -> display in UI + forward final to DO
   - `agent_audio` -> play through AudioContext (AssemblyAI handles TTS)
   - `error` -> reconnect logic
4. Pass business-specific greeting to AssemblyAI so it speaks the correct welcome message
5. When DO sends a question text to the browser, the browser needs AssemblyAI to speak it:
   - Option A: Use AssemblyAI's `send_text` or `generate_reply` API to inject text for the agent to speak
   - Option B: The AssemblyAI agent is configured as a tool-calling agent that calls back to a Worker endpoint for the current question text (HTTP tool)

**Recommended approach:** The AssemblyAI agent uses HTTP tools to call the Worker for the current question/context. The Worker reads from the DO's state. This keeps the agent self-directed.

```
AssemblyAI agent HTTP tool: GET /api/context/:sessionId
  -> Returns: { "current_question": "Do you have an appointment?", "state": "asking_questions", ... }
```

This way AssemblyAI's LLM naturally asks the right question, the browser doesn't need to inject text, and the voice conversation feels natural.

**Acceptance:**
- Browser opens WebSocket to AssemblyAI using minted token (`wss://agents.assemblyai.com/v1/ws?token=...`).
- Voice conversation works: user speaks, agent responds.
- Agent asks the correct business questions from D1 (via HTTP tool callback).
- Transcripts flow: AssemblyAI -> browser -> DO.

---

### 2.5 — End-to-End Integration Test
**Effort:** 2-3h | **Blocks:** 3.1
**Dependencies:** 2.3, 2.4

Test script:
1. Open `@Virtu_intake_bot` in Telegram
2. Tap "Open Virtualobby"
3. App loads, parses `start_param`, requests session UUID, connects both WebSockets
4. Agent greets by voice: "Welcome to Demo Clinic! I will help you check in."
5. User speaks: "Yes I have an appointment" -> transcript appears, DO advances state
6. Agent asks next question by voice
7. User answers all questions by voice
8. Agent asks to scan ID -> camera opens -> photo taken -> uploaded via presigned R2 URL -> OCR results shown
9. Agent reads back summary -> user confirms
10. "You're checked in!" -> data in D1

**Acceptance:** Full flow works end-to-end. Two concurrent visitors to the same business get isolated sessions (no state collision).

---

## Phase 3: Polish & Demo Prep (Days 6-7)

### 3.1 — Multi-language Support
**Effort:** 2-3h | **Dependencies:** 2.5

- AssemblyAI Voice Agent handles multi-language natively (auto-detect)
- Business config: add `language` field to D1 businesses table
- Update agent system prompt to respond in detected language
- Add language indicator in UI

**Acceptance:** Same flow works in English and Spanish.

---

### 3.2 — Admin Panel
**Effort:** 3-4h | **Dependencies:** 2.2

**File:** `telegram/webapp/admin.html` (vanilla HTML/JS, no build step)

Features:
- View businesses list
- Add/edit business (name, welcome message, voice_persona, requires_id_scan)
- View questions per business (add/edit/reorder)
- View registrations per business (read-only table)
- Generate QR codes per business

> **⚠️ REVIEW FIX:** Admin endpoints validate `Telegram.WebApp.initData` HMAC using bot token to prevent spoofed requests. Admin page parses `initDataUnsafe.user.id` and checks against allowed admin IDs.

**Acceptance:** Admin can create a new business, add questions, view registrations, generate QR code.

---

### 3.3 — Error Handling & Edge Cases
**Effort:** 2-3h | **Dependencies:** 2.5

Handle:
- **WebSocket disconnect** (DO or AssemblyAI) -> auto-reconnect (3 attempts), then show error
- **Session token expired** (60s) -> re-fetch from `/api/token`, reconnect AssemblyAI WS
- **Session timeout** (10min idle via DO alarm) -> save partial data to D1 (status: 'partial'), notify user
- **Audio not supported** -> fallback to text input field, send as `user_transcript`
- **Camera denied** -> skip document scan (`requires_id_scan=0` or manual skip), ask info verbally
- **Vision API failure** -> fall back to asking user to describe their document verbally
- **AssemblyAI rate limit** -> exponential backoff on token requests
- **Presigned URL expired** -> re-request from `/api/upload-url`

**Acceptance:** App doesn't crash on any of the above scenarios. Graceful degradation in all cases.

---

### 3.4 — QR Code & Business Onboarding
**Effort:** 1h | **Dependencies:** 3.2

- Generate QR code per business: `https://t.me/Virtu_intake_bot?start=business_<id>`
- Simple admin flow to add new business + questions (via admin.html)
- New business gets default welcome message and 0 questions (admin adds them)

**Acceptance:** Scan QR -> opens Telegram bot -> correct business pre-selected via `start_param`. Admin can add a new business from the admin panel.

---

## Phase 4: Demo & Submission (Days 8-9)

### 4.1 — Demo Video
**Effort:** 3-4h | **Dependencies:** 3.1

Script:
1. **Hook (10s):** "What if your phone WAS the reception desk?"
2. **Problem (15s):** Long waits, paper forms, language barriers
3. **Solution (30s):** Open Telegram -> voice check-in -> done in 90 seconds
4. **Tech (20s):** AssemblyAI Voice Agent API + Cloudflare Durable Objects
5. **Live demo (45s):** Full check-in flow on a real phone (voice + camera)
6. **Multi-language (15s):** Same flow in Spanish
7. **Close (10s):** "Virtualobby — your phone is the reception desk"

**Acceptance:** 2-3 minute video, clear audio, real device footage.

---

### 4.2 — Submission Package
**Effort:** 1-2h | **Dependencies:** 4.1

- GitHub repo clean and documented
- README with architecture diagram, setup instructions, demo link
- Environment variables documented in `.env.example`
- Demo URL live and stable
- `schema.sql` and `seed.sql` for reproducibility

**Acceptance:** Judge can clone repo, follow README, run locally.

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | ~~AssemblyAI session token endpoint wrong~~ | ~~Critical~~ | ~~---~~ | **FIXED v2:** Corrected to `GET agents.assemblyai.com/v1/token?product=voice_agent`. Verified against working `deployment/browser/server.py`. |
| 2 | ~~DO state collision (per-business key)~~ | ~~Critical~~ | ~~---~~ | **FIXED v2:** UUID-based DO instances. Each visitor gets isolated DO. |
| 3 | ~~Voice persona "alloy" (OpenAI, not AssemblyAI)~~ | ~~High~~ | ~~---~~ | **FIXED v2:** Changed to `"anna"` (AssemblyAI voice). All voice_persona values must use AssemblyAI voice catalog. |
| 4 | ~~Base64 images over WebSocket (2-6MB)~~ | ~~High~~ | ~~---~~ | **FIXED v2:** Presigned R2 URL upload. Browser uploads directly to R2, sends only key to DO. |
| 5 | Browser can't maintain two WebSocket connections simultaneously | **High** | Low | Both are standard WS; Telegram Mini App WebView supports it. **Test on Day 2** (not Day 5) to catch early. |
| 6 | Vision model OCR quality insufficient | **Medium** | Medium | Test with `@cf/meta/llama-3.2-11b-vision` early; fall back to external API (OpenAI Vision) if Workers AI accuracy is poor. |
| 7 | AssemblyAI agent can't ask dynamic questions via HTTP tools | **Medium** | Medium | Fallback: browser injects question text into AssemblyAI via `send_text` API. Test HTTP tool approach first. |
| 8 | D1 cold start latency causes slow greeting | **Low** | Low | Pre-warm with health check endpoint. Business config rarely changes, consider caching. |
| 9 | DO in-memory state lost on restart | **Medium** | Low | Re-read business config from D1 on reconnect. Partial answers are ephemeral by design (short sessions). |
| 10 | Telegram WebView limits (camera, microphone) | **Medium** | Low | Telegram Mini Apps support both. Test on real device in Phase 2. |
| 11 | API keys in wrangler.toml [vars] exposed | **Medium** | Low | **FIXED v2:** Use Wrangler secrets for `ASSEMBLYAI_API_KEY` and `AGENT_ID`. |
| 12 | Presigned URL expires before upload completes | **Low** | Low | 5-minute expiry is generous. Frontend re-requests if expired. |

---

## File Structure (Target)

```
intakeai/
+-- agents/
|   +-- intake-clinic.jsonc          # AssemblyAI agent definition (voice_id: "anna")
+-- api/
|   +-- worker.js                    # Router + REST endpoints + token proxy + presigned URLs
|   +-- checkin-do.js                # Durable Object (FSM + D1/R2, UUID-based, NO audio relay)
|   +-- data/
|       +-- submissions.json         # Legacy (remove after D1 migration -- no data to migrate)
+-- telegram/
|   +-- webapp/
|       +-- index.html               # Main Mini App (dual WS: DO + AssemblyAI)
|       +-- app.js                   # Frontend logic (WS + presigned upload + start_param parsing)
|       +-- style.css                # Mobile-first styles
|       +-- admin.html               # Admin panel (vanilla HTML/JS, initData HMAC validation)
|       +-- visit.html               # Visit summary
+-- deployment/
|   +-- browser/                     # AssemblyAI browser deployment (reference)
+-- wrangler.toml                    # CF config (Worker + D1 + R2 + DO). NO secrets in [vars].
+-- schema.sql                       # D1 schema (3 tables, for reproducibility)
+-- seed.sql                         # D1 seed data
+-- publish.py                       # AssemblyAI agent publisher
+-- lib.py                           # Shared Python utils
+-- README.md
```

---

## Summary of Changes from Original Plan

| Area | Original Plan | Revised Plan |
|------|--------------|--------------|
| D1 Schema | 4 tables (businesses, questionnaires, submissions, sessions) | 3 tables (businesses, business_questions, guest_registrations). No sessions table. |
| Voice Architecture | DO relays audio browser<->AssemblyAI (Option A) | Browser connects to AssemblyAI directly. DO receives text transcripts only. |
| DO responsibilities | FSM + audio relay + D1 + R2 | FSM + D1 queries + R2 storage. NO audio. |
| OCR | Tesseract.js client-side | Vision model server-side (Workers AI or external API) |
| TTS | Web Speech API | AssemblyAI Voice Agent native TTS |
| Admin Dashboard | (implied React/framework) | Vanilla HTML/JS, fetch() to Worker API |
| Session Token | Not addressed | Worker proxies `GET agents.assemblyai.com/v1/token` (corrected from wrong endpoint) |
| Task 2.4 | "AssemblyAI Voice Agent <-> DO Integration" (complex relay) | "AssemblyAI Browser Connection" (simpler, browser-direct) |
| Schema field names | `type`, `config JSON`, `question_type` | `business_type`, `welcome_message`, `voice_persona`, `requires_id_scan`, `field_key`, `validation_type` |
| DO key | Per-business (`/api/ws/:businessId`) | Per-visitor UUID (`/api/ws/<uuid>`) — prevents state collision |
| Image upload | base64 over WebSocket | Presigned R2 URL — browser uploads directly, sends key to DO |
| Voice persona | `"alloy"` (OpenAI voice) | `"anna"` (AssemblyAI voice catalog only) |
| Security | API key in wrangler.toml [vars] | Wrangler secrets for `ASSEMBLYAI_API_KEY` and `AGENT_ID` |
| CORS | Not addressed | All `/api/*` endpoints return `Access-Control-Allow-Origin` headers |
| Dual-WS testing | Day 5 | Day 2 — catch WebView compatibility issues early |

---

## Timeline

| Day | Phase | Tasks |
|-----|-------|-------|
| 1 | Foundation | 1.1 D1 schema (3 tables + `schema.sql`), 1.2 R2 bucket, 1.3 seed data (`seed.sql`). Security: `wrangler secret put ASSEMBLYAI_API_KEY`. |
| 2 | Foundation | 1.4 Publish agent, 1.5 Session token endpoint. **Test dual-WS in Telegram WebView.** |
| 3 | Core | 2.1 Durable Object (FSM + UUID-based instances) |
| 4 | Core | 2.2 Worker router (API + presigned URLs + CORS), 2.3 Frontend refactor (dual WS + start_param + presigned upload) |
| 5 | Core | 2.4 AssemblyAI browser connection, 2.5 E2E integration test |
| 6 | Polish | 3.1 Multi-language, 3.2 Admin panel (vanilla HTML), 3.3 Error handling |
| 7 | Polish | 3.4 QR codes, buffer day |
| 8 | Demo | 4.1 Video (2-3 min), 4.2 Submission package |
| 9 | Buffer | Final fixes, deploy, README |

**Total: ~9 days.** Hackathon deadline Sep 30.

---

*Plan v2 — Technical review fixes applied 2026-09-10.*
*Previous versions: v1 (initial), v1-revised (architecture merge).*

<img src="assemblyai.png" width="500"/>

---

# Virtualobby — Universal Virtual Reception Agent

[![Voice Agent API](https://img.shields.io/badge/docs-Voice%20Agent%20API-2545E6)](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.9-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![AssemblyAI](https://img.shields.io/badge/AssemblyAI-Voice%20Agent-2545E6)](https://www.assemblyai.com)

> **Scan documents, ask questions, register visitors — all by voice.**

Virtualobby is a universal reception agent powered by AssemblyAI's Voice Agent API. It combines voice interaction with document scanning (OCR) to automate visitor registration for any business.

## 🎯 What it does

1. **Greets** the visitor by voice
2. **Scans** their ID document via camera (OCR)
3. **Asks** business-specific questionnaire questions
4. **Confirms** all information by voice
5. **Registers** the visitor automatically

## 🏢 Works for any business

| Template | Use case |
|----------|----------|
| 🏥 `clinic` | Medical clinic check-in, triaje |
| ⚖️ `lawyer` | Law firm client intake |
| 🏨 `hotel` | Hotel guest check-in |
| 🏢 `office` | Office visitor registration |
| 🎪 `event` | Event attendee registration |

## 📱 WebApp (Mobile-First)

The webapp works as:

1. **Telegram Mini App** — Open @Virtualobby_bot in Telegram
2. **Standalone Web Page** — Open the URL directly in any browser

### Features

- 📷 Camera access for document scanning
- 🎤 Voice interaction with AssemblyAI
- 📱 Mobile-first responsive design
- 🔍 Browser-side OCR with Tesseract.js
- 🎯 Works on phone, tablet, and desktop

## 🚀 Quick Start (real deployment: Cloudflare)

This is what's actually deployed and what `telegram/webapp/app.js` and
`admin.html` talk to — not the Python server described further down, which is
an earlier/reference build. See `PLAN.md` for the full architecture writeup.

### 1. Clone & configure

```sh
git clone https://github.com/Alejdro83/intakeai.git
cd intakeai
wrangler login
```

### 2. Create the D1 database and R2 bucket (first deploy only)

```sh
wrangler d1 create virtualobby-db      # copy the returned database_id into wrangler.toml
wrangler r2 bucket create virtualobby-docs
wrangler d1 execute virtualobby-db --remote --file ./schema.sql
wrangler d1 execute virtualobby-db --remote --file ./seed.sql
```

### 3. Set secrets

```sh
wrangler secret put ASSEMBLYAI_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN   # only needed for the Telegram bot webhook
```

`ADMIN_TELEGRAM_IDS` (who can use `admin.html`'s write endpoints) is a plain
var in `wrangler.toml`, not a secret — edit it directly.

### 4. Deploy

```sh
wrangler deploy
```

The Worker serves the API (`api/worker.js` + the `CheckinSession` Durable
Object in `api/checkin-do.js`). `telegram/webapp/` (the two UIs) is a static
site — deploy it separately as a Cloudflare Pages project, or serve it from
any static host, pointed at your Worker's URL via `CONFIG.API_URL` in `app.js`.

### 5. Open it

- Visitor check-in: your Pages URL, or as a Telegram Mini App via
  `https://t.me/<your_bot>?start=business_<id>`
- Admin panel: `<your-pages-url>/admin.html`

## 📁 Project Structure

```
intakeai/
├── agents/
│   └── intake-clinic.jsonc    # AssemblyAI agent definition — NOT used by the live
│                               # app (app.js configures the agent per-session via
│                               # session.update instead); kept as reference/legacy
├── api/
│   ├── worker.js               # Cloudflare Worker: REST API, AssemblyAI token proxy,
│   │                            # Telegram initData auth
│   └── checkin-do.js           # Durable Object: per-visitor FSM, D1 writes, R2 reads,
│                                # Workers AI OCR
├── schema.sql / seed.sql       # D1 schema + demo data
├── wrangler.toml                # Cloudflare Worker + D1 + R2 + DO + Workers AI config
├── telegram/webapp/             # The two UIs (static, no build step)
│   ├── index.html / app.js      # Visitor check-in (voice + camera)
│   ├── admin.html                # Business/questions config + registrations
│   └── visit.html
├── deployment/, api/server.py, lib.py, publish.py, import_agent.py
│                               # Earlier plain-Python build from the AssemblyAI
│                               # starter template — see AGENTS.md. Not what's
│                               # deployed; kept for local experimentation.
└── PLAN.md                     # Full architecture + decision log
```

## 🔧 API Endpoints (Cloudflare Worker, `api/worker.js`)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | — | Health check |
| `/api/token` | GET | — | Mints a short-lived AssemblyAI Voice Agent token |
| `/api/ws/:sessionId` | GET | — | WebSocket upgrade to that visitor's Durable Object |
| `/api/ws/:sessionId` | PUT | session state | Upload the ID photo (only while that session is `scanning_doc`) |
| `/api/businesses` | GET | — | List businesses |
| `/api/businesses` | POST | admin | Create a business (+ its questions) |
| `/api/businesses/:id` | GET/PUT/DELETE | PUT/DELETE: admin | Get/update/delete a business |
| `/api/businesses/:id/questions` | GET/POST/DELETE | POST/DELETE: admin | Get/replace/clear a business's questions |
| `/api/businesses/:id/registrations` | GET | admin | List completed check-ins (PII) |
| `/api/telegram` | POST | — | Telegram bot webhook |

"admin" endpoints require an `X-Telegram-Init-Data` header carrying
`Telegram.WebApp.initData`, verified server-side against `ADMIN_TELEGRAM_IDS`.

## 🎤 How the Voice Agent Works

The live app does **not** use a published AssemblyAI agent (`agents/intake-clinic.jsonc`
is legacy/reference — see above). Instead, `app.js` connects the browser
directly to `wss://agents.assemblyai.com/v1/ws` with a token minted by
`GET /api/token`, then configures the whole conversation per-session via
`session.update`: the system prompt, greeting, and OCR data (if any) are built
client-side from what the Durable Object already sent over its own WebSocket,
and a `submit_answer` (plus, while scanning, `submit_ocr_data`) function tool
lets the agent report back what the visitor said. The Durable Object never
talks to AssemblyAI directly — it only holds the FSM state, D1 reads/writes,
and runs OCR via Workers AI when a document photo comes in.

## 📱 Telegram Mini App

To set up as a Telegram Mini App:

1. Create a bot with @BotFather
2. Set the WebApp URL to your deployed static site (Pages URL)
3. Users can open the Mini App from the bot menu, or via
   `https://t.me/<bot>?start=business_<id>` to preselect a business

## 📋 Adding a New Business Template

Use `admin.html` (needs a Telegram ID in `ADMIN_TELEGRAM_IDS`), or call the
API directly:

```sh
curl -X POST https://<your-worker>/api/businesses \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Init-Data: <initData from Telegram.WebApp>" \
  -d '{
    "name": "My Business", "business_type": "office",
    "welcome_message": "Welcome!", "voice_persona": "anna",
    "requires_id_scan": true,
    "questions": ["First question?", "Second question?"]
  }'
```

## 🏆 Hackathon: AssemblyAI Voice Agent Hackathon

- **Event:** [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/)
- **Deadline:** September 30, 2026
- **Prize:** $10,000 ($5K cash + $5K AAI credits)

### What makes Virtualobby different

- **Multimodal** — voice + vision (document scanning)
- **Universal** — works for any business with configurable templates
- **Real-world value** — eliminates repetitive reception work
- **Mobile-first** — works on phone, tablet, and desktop
- **Telegram integration** — Mini App for zero-friction access

## 📚 References

- [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [Voice Agent Starter (Python)](https://github.com/AssemblyAI/voice-agent-starter-python)
- [AssemblyAI Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices)
- [Telegram Mini Apps](https://core.telegram.org/api/webapps)

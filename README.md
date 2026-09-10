<img src="assemblyai.png" width="500"/>

---

# IntakeAI — Universal Voice-Powered Reception Agent

[![Voice Agent API](https://img.shields.io/badge/docs-Voice%20Agent%20API-2545E6)](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.9-3776AB?logo=python&logoColor=white)](https://www.python.org)
[![AssemblyAI](https://img.shields.io/badge/AssemblyAI-Voice%20Agent-2545E6)](https://www.assemblyai.com)

> **Scan documents, ask questions, register visitors — all by voice.**

IntakeAI is a universal reception agent powered by AssemblyAI's Voice Agent API. It combines voice interaction with document scanning (OCR) to automate visitor registration for any business.

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

1. **Telegram Mini App** — Open @IntakeAI_bot in Telegram
2. **Standalone Web Page** — Open the URL directly in any browser

### Features

- 📷 Camera access for document scanning
- 🎤 Voice interaction with AssemblyAI
- 📱 Mobile-first responsive design
- 🔍 Browser-side OCR with Tesseract.js
- 🎯 Works on phone, tablet, and desktop

## 🚀 Quick Start

### 1. Clone & configure

```sh
git clone https://github.com/Alejdro83/intakeai.git
cd intakeai
cp .env.example .env
# Add your ASSEMBLYAI_API_KEY to .env
```

### 2. Start the server

```sh
python api/server.py
# 🏥 IntakeAI running on http://localhost:8001
```

### 3. Open the webapp

```
http://localhost:8001/
```

## 📁 Project Structure

```
intakeai/
├── agents/
│   └── intake-clinic.jsonc    # Voice agent definition
├── api/
│   └── server.py              # Backend API + WebApp server
│   └── data/
│       └── submissions.json   # Registered visitors (auto-created)
├── telegram/
│   └── webapp/                # Frontend webapp
│       ├── index.html         # Main page
│       ├── app.js             # JavaScript logic
│       └── style.css          # Mobile-first styles
├── deployment/
│   └── browser/               # Browser deployment (fallback)
├── lib.py                     # Shared utilities
├── publish.py                 # Publish agent to AssemblyAI
└── .env                       # Configuration (gitignored)
```

## 🔧 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | WebApp (index.html) |
| `/health` | GET | Health check |
| `/api/templates` | GET | List available business templates |
| `/api/questionnaire?business_type=clinic` | GET | Get questionnaire for business type |
| `/api/scan` | POST | OCR document scan |
| `/api/register` | POST | Register a visitor |
| `/api/submissions` | GET | List all registered visitors |

## 🎤 How the Voice Agent Works

The agent is defined in `agents/intake-clinic.jsonc` as a JSON file. It uses:

- **AssemblyAI Voice Agent API** — speech-to-speech conversation
- **HTTP Tools** — the agent calls our backend API mid-conversation:
  - `scan_document` — triggers OCR on the document
  - `get_questionnaire` — fetches questions for the business type
  - `register_visitor` — saves the completed registration

## 📱 Telegram Mini App

To set up as a Telegram Mini App:

1. Create a bot with @BotFather
2. Set the WebApp URL to your deployed server
3. Users can open the Mini App from the bot menu

## 📋 Adding a New Business Template

Edit `api/server.py` and add to the `QUESTIONNAIRES` dict:

```python
"my_business": {
    "name": "My Business",
    "icon": "🏢",
    "questions": [
        {"id": "q1", "question": "First question?", "type": "text"},
        {"id": "q2", "question": "Second question?", "type": "yes_no"},
    ]
}
```

## 🏆 Hackathon: AssemblyAI Voice Agent Hackathon

- **Event:** [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon/)
- **Deadline:** September 30, 2026
- **Prize:** $10,000 ($5K cash + $5K AAI credits)

### What makes IntakeAI different

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

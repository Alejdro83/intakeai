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

## 🚀 Quick Start

### 1. Clone & configure

```sh
git clone https://github.com/YOUR_USER/intakeai.git
cd intakeai
cp .env.example .env
# Add your ASSEMBLYAI_API_KEY to .env
```

### 2. Start the backend API

```sh
python api/server.py
# 🏥 IntakeAI API running on http://localhost:8001
```

### 3. Publish the agent

```sh
python publish.py
# Creates/updates the agent in your AssemblyAI account
```

### 4. Open the browser

```sh
python deployment/browser/server.py
# Talk to it: http://localhost:3000
```

## 📁 Project Structure

```
intakeai/
├── agents/
│   └── intake-clinic.jsonc    # Voice agent definition
├── api/
│   └── server.py              # Backend API (OCR, questionnaires, registration)
│   └── data/
│       └── submissions.json   # Registered visitors (auto-created)
├── deployment/
│   └── browser/
│       ├── server.py          # Web server (serves UI + mints tokens)
│       ├── index.html         # Browser UI
│       └── app.js             # Client-side voice agent code
├── lib.py                     # Shared utilities
├── publish.py                 # Publish agent to AssemblyAI
└── .env                       # Configuration (gitignored)
```

## 🔧 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
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
- **Built on Virtu** — uses proven OCR and session management from Virtu

## 📚 References

- [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [Voice Agent Starter (Python)](https://github.com/AssemblyAI/voice-agent-starter-python)
- [AssemblyAI Voices](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices)

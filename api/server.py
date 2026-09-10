#!/usr/bin/env python3
"""Virtualobby Backend API + WebApp Server

Handles document scanning, questionnaire management, visitor registration,
and serves the webapp frontend.

    python api/server.py

Endpoints:
    GET  /                  — WebApp (index.html)
    GET  /style.css         — WebApp styles
    GET  /app.js            — WebApp JavaScript
    GET  /health            — Health check
    GET  /api/templates     — List business templates
    GET  /api/questionnaire — Get questionnaire by business type
    GET  /api/submissions   — List all submissions
    POST /api/scan          — Document scan
    POST /api/register      — Register visitor
"""

import base64
import json
import os
import sys
import uuid
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Configuration ──────────────────────────────────────────────────────────

AAI_API_KEY = os.environ.get("ASSEMBLYAI_API_KEY", "")
LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions"
WEBAPP_DIR = Path(__file__).parent.parent / "telegram" / "webapp"

# ── Questionnaire Templates ────────────────────────────────────────────────

QUESTIONNAIRES: Dict[str, Dict[str, Any]] = {
    "clinic": {
        "name": "Medical Clinic",
        "icon": "🏥",
        "questions": [
            {"id": "appointment", "question": "Do you have an appointment today?", "type": "yes_no"},
            {"id": "doctor", "question": "Which doctor are you here to see?", "type": "text"},
            {"id": "reason", "question": "What is the reason for your visit today?", "type": "text"},
            {"id": "allergies", "question": "Do you have any known allergies?", "type": "text"},
            {"id": "medication", "question": "Are you currently taking any medication?", "type": "text"},
            {"id": "insurance", "question": "Do you have medical insurance? If yes, which provider?", "type": "text"},
        ]
    },
    "lawyer": {
        "name": "Law Firm",
        "icon": "⚖️",
        "questions": [
            {"id": "case_type", "question": "What type of legal matter do you need help with? For example: civil, criminal, labor, family, or real estate.", "type": "text"},
            {"id": "description", "question": "Could you briefly describe your situation?", "type": "text"},
            {"id": "documents", "question": "Do you have any relevant documents with you?", "type": "yes_no"},
            {"id": "previous_lawyer", "question": "Have you consulted with another lawyer about this matter before?", "type": "yes_no"},
            {"id": "urgency", "question": "How urgent is this matter? Is there a deadline approaching?", "type": "text"},
            {"id": "preferred_language", "question": "What language would you prefer for your consultation?", "type": "text"},
        ]
    },
    "hotel": {
        "name": "Hotel",
        "icon": "🏨",
        "questions": [
            {"id": "reservation", "question": "Do you have a reservation? If yes, what name is it under?", "type": "text"},
            {"id": "check_in_date", "question": "What is your check-in date?", "type": "text"},
            {"id": "check_out_date", "question": "What is your expected check-out date?", "type": "text"},
            {"id": "room_preference", "question": "Do you have any room preferences? For example: smoking or non-smoking, high floor, quiet room.", "type": "text"},
            {"id": "special_requests", "question": "Do you have any special requests? For example: extra pillows, early check-in, airport transfer.", "type": "text"},
            {"id": "purpose", "question": "What brings you here? Business or leisure?", "type": "text"},
        ]
    },
    "office": {
        "name": "Office Reception",
        "icon": "🏢",
        "questions": [
            {"id": "company", "question": "What company are you visiting?", "type": "text"},
            {"id": "contact_person", "question": "Who are you here to see?", "type": "text"},
            {"id": "department", "question": "Which department?", "type": "text"},
            {"id": "purpose", "question": "What is the purpose of your visit?", "type": "text"},
            {"id": "has_appointment", "question": "Do you have a scheduled appointment?", "type": "yes_no"},
            {"id": "parking", "question": "Did you need parking validation?", "type": "yes_no"},
        ]
    },
    "event": {
        "name": "Event Registration",
        "icon": "🎪",
        "questions": [
            {"id": "event_name", "question": "Which event are you attending?", "type": "text"},
            {"id": "ticket_type", "question": "What type of ticket do you have? VIP, general admission, or speaker?", "type": "text"},
            {"id": "company", "question": "What company or organization are you with?", "type": "text"},
            {"id": "dietary", "question": "Do you have any dietary restrictions?", "type": "text"},
            {"id": "tshirt_size", "question": "What t-shirt size would you like?", "type": "text"},
        ]
    }
}


# ── Document Scanning ──────────────────────────────────────────────────────

def scan_document_browser_ocr(ocr_data: Dict[str, Any]) -> Dict[str, Any]:
    """Parse OCR results from browser-side Tesseract.js."""
    raw_text = ocr_data.get("raw_text", "")
    confidence = ocr_data.get("confidence", 0.0)
    
    fields = {}
    lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
    
    import re
    
    for i, line in enumerate(lines):
        lower = line.lower()
        
        if any(kw in lower for kw in ["nombre", "name", "nom:", "apellido"]):
            if i + 1 < len(lines):
                fields["full_name"] = lines[i + 1]
        
        if any(kw in lower for kw in ["dni", "nif", "nie", "id:", "document", "passport", "no."]):
            numbers = re.findall(r'\d{5,}[A-Z]?', line)
            if numbers:
                fields["id_number"] = numbers[0]
            elif i + 1 < len(lines):
                numbers = re.findall(r'\d{5,}[A-Z]?', lines[i + 1])
                if numbers:
                    fields["id_number"] = numbers[0]
        
        if any(kw in lower for kw in ["nacimiento", "birth", "born", "fecha"]):
            dates = re.findall(r'\d{2}[/-]\d{2}[/-]\d{4}', line)
            if dates:
                fields["date_of_birth"] = dates[0]
        
        if any(kw in lower for kw in ["nacionalidad", "nationality", "nac."]):
            if i + 1 < len(lines):
                fields["nationality"] = lines[i + 1]
    
    if not fields and raw_text:
        id_matches = re.findall(r'\b\d{5,8}[A-Z]?\b', raw_text)
        if id_matches:
            fields["id_number"] = id_matches[0]
        
        date_matches = re.findall(r'\b\d{2}[/-]\d{2}[/-]\d{4}\b', raw_text)
        if date_matches:
            fields["date_of_birth"] = date_matches[0]
    
    return {
        "success": True,
        "fields": fields,
        "document_type": "ID Card",
        "confidence": confidence,
        "raw_text": raw_text,
        "source": "browser_tesseract"
    }


def scan_document_assemblyai_llm(image_base64: str) -> Dict[str, Any]:
    """Scan document using AssemblyAI LLM Gateway (when available)."""
    if not AAI_API_KEY:
        return {"success": False, "error": "ASSEMBLYAI_API_KEY not configured", "fields": {}}
    
    try:
        payload = json.dumps({
            "model": "gemini-2.5-flash",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Extract all text from this document image. Return JSON with fields: full_name, id_number, date_of_birth, nationality, expiry_date, raw_text"},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
                ]
            }],
            "max_tokens": 500
        }).encode()
        
        req = urllib.request.Request(
            LLM_GATEWAY_URL,
            data=payload,
            headers={"Authorization": AAI_API_KEY, "Content-Type": "application/json"},
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
        
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        
        try:
            parsed = json.loads(content) if content.startswith("{") else {"raw_text": content}
        except json.JSONDecodeError:
            parsed = {"raw_text": content}
        
        return {
            "success": True,
            "fields": parsed.get("fields", {}),
            "document_type": parsed.get("document_type", "Unknown"),
            "confidence": parsed.get("confidence", 0.8),
            "raw_text": parsed.get("raw_text", content),
            "source": "assemblyai_llm_gateway"
        }
        
    except Exception as e:
        return {"success": False, "error": str(e), "fields": {}}


# ── Storage ────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data"
SUBMISSIONS_FILE = DATA_DIR / "submissions.json"


def load_submissions() -> List[Dict[str, Any]]:
    if not SUBMISSIONS_FILE.exists():
        return []
    try:
        return json.loads(SUBMISSIONS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def save_submission(submission: Dict[str, Any]) -> str:
    DATA_DIR.mkdir(exist_ok=True)
    submissions = load_submissions()
    submission["id"] = str(uuid.uuid4())[:8]
    submission["timestamp"] = datetime.now().isoformat()
    submissions.append(submission)
    SUBMISSIONS_FILE.write_text(json.dumps(submissions, indent=2))
    return submission["id"]


# ── Static File Serving ────────────────────────────────────────────────────

STATIC_FILES = {
    "/": ("index.html", "text/html"),
    "/index.html": ("index.html", "text/html"),
    "/style.css": ("style.css", "text/css"),
    "/app.js": ("app.js", "text/javascript"),
}


def get_static_file(path: str) -> Optional[tuple]:
    """Get static file content and content type."""
    file_info = STATIC_FILES.get(path)
    if not file_info:
        return None
    
    filename, content_type = file_info
    filepath = WEBAPP_DIR / filename
    
    if not filepath.exists():
        return None
    
    return (filepath.read_bytes(), content_type)


# ── HTTP Handler ───────────────────────────────────────────────────────────

class IntakeHandler(BaseHTTPRequestHandler):

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data).encode()
        self._send(status, body, "application/json")

    def _read_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self) -> None:
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        
        # Serve static files
        static = get_static_file(path)
        if static:
            content, content_type = static
            self._send(200, content, content_type)
            return
        
        # API endpoints
        if path == "/health":
            self._send_json(200, {
                "status": "ok",
                "service": "Virtualobby",
                "templates": list(QUESTIONNAIRES.keys()),
                "submissions": len(load_submissions()),
                "assemblyai_configured": bool(AAI_API_KEY),
                "ocr_mode": "browser_tesseract" if not AAI_API_KEY else "assemblyai_llm_gateway"
            })
            return

        if path == "/api/questionnaire":
            params = dict(p.split("=") for p in self.path.split("?")[1].split("&") if "=" in p) if "?" in self.path else {}
            business_type = params.get("business_type", "clinic")
            template = QUESTIONNAIRES.get(business_type)
            if not template:
                self._send_json(404, {"error": f"Unknown business type: {business_type}"})
                return
            self._send_json(200, {"business_type": business_type, "template": template})
            return

        if path == "/api/submissions":
            self._send_json(200, {"submissions": load_submissions()})
            return

        if path == "/api/templates":
            self._send_json(200, {
                name: {"name": t["name"], "icon": t["icon"], "question_count": len(t["questions"])}
                for name, t in QUESTIONNAIRES.items()
            })
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        body = self._read_body()

        if path == "/api/scan":
            if "raw_text" in body:
                result = scan_document_browser_ocr(body)
            elif "image_data" in body:
                result = scan_document_assemblyai_llm(body["image_data"])
            else:
                self._send_json(400, {"error": "Provide raw_text (browser OCR) or image_data (LLM Gateway)"})
                return
            self._send_json(200, result)
            return

        if path == "/api/register":
            visitor_data = body.get("visitor_data", {})
            business_type = body.get("business_type", "unknown")
            confirmed = body.get("confirmed", False)
            if not confirmed:
                self._send_json(400, {"error": "Visitor must confirm data before registration"})
                return
            submission = {
                "visitor": visitor_data,
                "business_type": business_type,
                "confirmed": confirmed,
                "source": "voice_agent"
            }
            submission_id = save_submission(submission)
            self._send_json(200, {
                "success": True,
                "submission_id": submission_id,
                "message": f"Visitor registered successfully. ID: {submission_id}"
            })
            return

        self._send_json(404, {"error": "Not found"})

    def log_message(self, format: str, *args: Any) -> None:
        pass


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> None:
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())
    
    global AAI_API_KEY
    AAI_API_KEY = os.environ.get("ASSEMBLYAI_API_KEY", "")
    
    port = int(os.environ.get("INTAKE_PORT", "8001"))
    server = ThreadingHTTPServer(("", port), IntakeHandler)
    
    print(f"🏥 Virtualobby running on http://localhost:{port}")
    print(f"   WebApp: http://localhost:{port}/")
    print(f"   Health: http://localhost:{port}/health")
    print(f"   Templates: http://localhost:{port}/api/templates")
    print(f"   AssemblyAI: {'✅ configured' if AAI_API_KEY else '❌ not configured'}")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
        print("\n👋 Shutting down Virtualobby")


if __name__ == "__main__":
    main()

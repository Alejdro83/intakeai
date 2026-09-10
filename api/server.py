#!/usr/bin/env python3
"""IntakeAI Backend API

Handles OCR document scanning, questionnaire management, and visitor registration.
Used by the AssemblyAI Voice Agent via HTTP tools.

    python api/server.py

Endpoints:
    POST /api/scan          — OCR document scan
    GET  /api/questionnaire — Get questionnaire by business type
    POST /api/register      — Register visitor
    GET  /api/submissions   — List all submissions
    GET  /health            — Health check
"""

import base64
import json
import os
import sys
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

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


# ── OCR Simulation (replace with real OCR in production) ───────────────────

def simulate_ocr(image_data: Optional[str] = None) -> Dict[str, Any]:
    """Simulate OCR extraction. In production, this would call a real OCR service."""
    # For the hackathon demo, we simulate document extraction
    # In production: use gemma4:e4b or similar OCR model
    return {
        "success": True,
        "fields": {
            "full_name": "John Smith",
            "id_number": "12345678A",
            "date_of_birth": "1985-03-15",
            "nationality": "US",
            "document_type": "ID Card",
            "expiry_date": "2028-06-20"
        },
        "confidence": 0.95,
        "raw_text": "SMITH\nJOHN\n12345678A\n15/03/1985\nUSA\n20/06/2028"
    }


# ── Storage (JSON file for hackathon) ──────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data"
SUBMISSIONS_FILE = DATA_DIR / "submissions.json"


def load_submissions() -> List[Dict[str, Any]]:
    """Load all submissions from disk."""
    if not SUBMISSIONS_FILE.exists():
        return []
    try:
        return json.loads(SUBMISSIONS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def save_submission(submission: Dict[str, Any]) -> str:
    """Save a new submission and return its ID."""
    DATA_DIR.mkdir(exist_ok=True)
    submissions = load_submissions()
    submission["id"] = str(uuid.uuid4())[:8]
    submission["timestamp"] = datetime.now().isoformat()
    submissions.append(submission)
    SUBMISSIONS_FILE.write_text(json.dumps(submissions, indent=2))
    return submission["id"]


# ── HTTP Handler ───────────────────────────────────────────────────────────

class IntakeHandler(BaseHTTPRequestHandler):
    """Handle IntakeAI API requests."""

    def _send_json(self, status: int, data: Any) -> None:
        """Send JSON response."""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> Dict[str, Any]:
        """Read and parse JSON request body."""
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight."""
        self._send_json(200, {"ok": True})

    def do_GET(self) -> None:
        """Handle GET requests."""
        path = self.path.split("?")[0]

        if path == "/health":
            self._send_json(200, {
                "status": "ok",
                "service": "IntakeAI",
                "templates": list(QUESTIONNAIRES.keys()),
                "submissions": len(load_submissions())
            })
            return

        if path == "/api/questionnaire":
            # Parse business_type from query string
            params = dict(p.split("=") for p in self.path.split("?")[1].split("&") if "=" in p) if "?" in self.path else {}
            business_type = params.get("business_type", "clinic")

            template = QUESTIONNAIRES.get(business_type)
            if not template:
                self._send_json(404, {"error": f"Unknown business type: {business_type}"})
                return

            self._send_json(200, {
                "business_type": business_type,
                "template": template
            })
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
        """Handle POST requests."""
        path = self.path.split("?")[0]
        body = self._read_body()

        if path == "/api/scan":
            # OCR document scan
            image_data = body.get("image_data")  # base64 encoded image
            result = simulate_ocr(image_data)
            self._send_json(200, result)
            return

        if path == "/api/register":
            # Register visitor
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
        """Suppress default logging."""
        pass


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> None:
    """Start the IntakeAI API server."""
    port = int(os.environ.get("INTAKE_PORT", "8001"))
    server = ThreadingHTTPServer(("", port), IntakeHandler)
    print(f"🏥 IntakeAI API running on http://localhost:{port}")
    print(f"   Health: http://localhost:{port}/health")
    print(f"   Templates: http://localhost:{port}/api/templates")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
        print("\n👋 Shutting down IntakeAI API")


if __name__ == "__main__":
    main()

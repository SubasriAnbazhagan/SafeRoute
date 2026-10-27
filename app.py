
import os
from dotenv import load_dotenv
from twilio.rest import Client

from flask import Flask, jsonify, render_template, request
from pathlib import Path
import sqlite3

app = Flask(__name__)
load_dotenv()

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_SMS_FROM = os.getenv("TWILIO_SMS_FROM")

twilio_client = None

if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    twilio_client = Client(
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN
    )


# Keep real alerts disabled until we finish testing.
ENABLE_REAL_ALERTS = False



BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "saferoute.db"

MAX_RETRIES = 3

def get_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def send_sms_to_contacts(message):
    if not ENABLE_REAL_ALERTS:
        return {
            "sent": 0,
            "failed": 0,
            "details": ["Real alerts are disabled for testing."]
        }

    if not twilio_client or not TWILIO_SMS_FROM:
        return {
            "sent": 0,
            "failed": 0,
            "details": ["Twilio credentials or sender number are missing."]
        }

    with get_db() as conn:
        contacts = conn.execute(
            "SELECT name, phone FROM contacts"
        ).fetchall()

    sent = 0
    failed = 0
    details = []

    for contact in contacts:
        phone = contact["phone"].strip()

        try:
            result = twilio_client.messages.create(
                body=message,
                from_=TWILIO_SMS_FROM,
                to=phone
            )
            sent += 1
            details.append({
                "name": contact["name"],
                "status": "submitted",
                "sid": result.sid
            })

        except Exception as error:
            failed += 1
            # Avoid returning sensitive credentials or detailed errors.
            details.append({
                "name": contact["name"],
                "status": "failed"
            })

    return {
        "sent": sent,
        "failed": failed,
        "details": details
    }


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                relationship TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_type TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                location TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Migrate an existing SafeRoute database safely.
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(alerts)")
        }

        if "attempt_count" not in columns:
            conn.execute(
                "ALTER TABLE alerts ADD COLUMN attempt_count "
                "INTEGER NOT NULL DEFAULT 0"
            )

        if "location" not in columns:
            conn.execute(
                "ALTER TABLE alerts ADD COLUMN location TEXT DEFAULT ''"
            )


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "application": "SafeRoute"
    })


# EMERGENCY CONTACTS

@app.route("/api/contacts", methods=["GET"])
def get_contacts():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM contacts ORDER BY id DESC"
        ).fetchall()

    return jsonify([dict(row) for row in rows])


@app.route("/api/contacts", methods=["POST"])
def add_contact():
    data = request.get_json(silent=True) or {}

    name = str(data.get("name", "")).strip()
    phone = str(data.get("phone", "")).strip()
    relationship = str(data.get("relationship", "")).strip()

    if not name or not phone:
        return jsonify({
            "error": "Name and phone number are required."
        }), 400

    if len(name) > 100 or len(phone) > 30:
        return jsonify({
            "error": "Name or phone number is too long."
        }), 400

    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO contacts (name, phone, relationship)
            VALUES (?, ?, ?)
        """, (name, phone, relationship))

        contact_id = cursor.lastrowid

    return jsonify({
        "id": contact_id,
        "name": name,
        "phone": phone,
        "relationship": relationship,
        "message": "Contact saved locally."
    }), 201
@app.route("/api/contacts", methods=["GET"])
def get_contacts():
    with get_db() as conn:
        contacts = conn.execute(
            "SELECT id, name, phone, relationship FROM contacts"
        ).fetchall()

    return jsonify([dict(contact) for contact in contacts])


@app.route("/api/contacts/<int:contact_id>", methods=["DELETE"])
def delete_contact(contact_id):
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM contacts WHERE id = ?",
            (contact_id,)
        )

    if cursor.rowcount == 0:
        return jsonify({"error": "Contact not found."}), 404

    return jsonify({"message": "Contact deleted."})


# ALERTS: accident, manual SOS, or health SOS

@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM alerts ORDER BY id DESC"
        ).fetchall()

    return jsonify([dict(row) for row in rows])


@app.route("/api/alerts", methods=["POST"])
def create_alert():
    data = request.get_json(silent=True) or {}

    alert_type = str(data.get("alert_type", "demo")).strip()
    message = str(data.get("message", "Test alert")).strip()
    location = str(data.get("location", "")).strip()

    allowed_types = {"demo", "accident", "health_sos", "manual_sos"}

    if alert_type not in allowed_types:
        return jsonify({"error": "Invalid alert type."}), 400

    if not message:
        return jsonify({"error": "Message is required."}), 400

    if len(message) > 1000 or len(location) > 500:
        return jsonify({"error": "Input is too long."}), 400

    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO alerts
                (alert_type, message, location, status, attempt_count)
            VALUES (?, ?, ?, 'pending', 0)
        """, (alert_type, message, location))

        alert_id = cursor.lastrowid

    # This records an alert locally; it does NOT send a notification.
    return jsonify({
        "id": alert_id,
        "status": "pending",
        "message": "Alert recorded locally. No notification sent."
    }), 201


@app.route("/api/alerts/<int:alert_id>/cancel", methods=["POST"])
def cancel_alert(alert_id):
    with get_db() as conn:
        cursor = conn.execute("""
            UPDATE alerts
            SET status = 'cancelled'
            WHERE id = ? AND status IN ('active', 'pending', 'retry_queued')
        """, (alert_id,))

    if cursor.rowcount == 0:
        return jsonify({
            "error": "Alert not found or can no longer be cancelled."
        }), 404

    return jsonify({
        "id": alert_id,
        "status": "cancelled"
    })


@app.route("/api/alerts/<int:alert_id>/retry", methods=["POST"])
def retry_alert(alert_id):
    with get_db() as conn:
        alert = conn.execute(
            "SELECT * FROM alerts WHERE id = ?",
            (alert_id,)
        ).fetchone()

        if alert is None:
            return jsonify({"error": "Alert not found."}), 404

        if alert["status"] == "cancelled":
            return jsonify({"error": "Cancelled alerts cannot be retried."}), 409

        if alert["attempt_count"] >= MAX_RETRIES:
            conn.execute(
                "UPDATE alerts SET status = 'failed' WHERE id = ?",
                (alert_id,)
            )
            return jsonify({
                "error": "Maximum retry count reached.",
                "attempts": alert["attempt_count"],
                "status": "failed"
            }), 409

        new_attempt = alert["attempt_count"] + 1

        # Track a retry request only. No real message is sent.
        conn.execute("""
            UPDATE alerts
            SET attempt_count = ?, status = 'retry_queued'
            WHERE id = ?
        """, (new_attempt, alert_id))

    return jsonify({
        "id": alert_id,
        "attempts": new_attempt,
        "max_retries": MAX_RETRIES,
        "status": "retry_queued",
        "message": "Retry recorded for simulation; no notification sent."
    })


if __name__ == "__main__":
    init_db()
    app.run(debug=True)

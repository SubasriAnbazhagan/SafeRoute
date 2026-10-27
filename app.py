import os
import re
import json
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from twilio.rest import Client

app = Flask(__name__)
load_dotenv()

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_SMS_FROM = os.getenv("TWILIO_SMS_FROM")

twilio_client = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
    twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

# Keep real alerts disabled until we finish testing.
ENABLE_REAL_ALERTS = False

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "saferoute.db"

ALERT_TYPES = {"demo", "accident", "health_sos", "manual_sos"}
OPEN_STATUSES = ("active", "pending", "retry_queued", "send_failed")
PHONE_RE = re.compile(r"^\+?[0-9\s\-()]{7,20}$")

DEFAULT_SETTINGS = {
    "seconds": 15,
    "rounds": 0,
    "interval": 30,
    "policy": "failed_or_unacked",
    "cancelPolicy": "immediate",
    "police": "",
}
ALLOWED_SETTING_VALUES = {
    "seconds": {10, 15, 20, 30},
    "rounds": {0, 1, 3, 5, 10},
    "interval": {10, 30, 60, 120, 300},
}


def get_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def error(message, code=400):
    return jsonify({"error": message}), code


def normalize_phone(phone):
    """Digits with an optional leading '+', for duplicate checks."""
    phone = phone.strip()
    digits = re.sub(r"\D", "", phone)
    return ("+" if phone.startswith("+") else "") + digits


def validate_phone(phone):
    if not PHONE_RE.match(phone):
        return "Enter a valid phone number (digits, spaces, +, -, brackets)."
    digit_count = len(re.sub(r"\D", "", phone))
    if not 7 <= digit_count <= 15:
        return "Phone number must have 7 to 15 digits."
    return None


def send_sms_to_contacts(message):
    if not ENABLE_REAL_ALERTS:
        return {"sent": 0, "failed": 0,
                "details": ["Real alerts are disabled for testing."]}

    if not twilio_client or not TWILIO_SMS_FROM:
        return {"sent": 0, "failed": 0,
                "details": ["Twilio credentials or sender number are missing."]}

    with get_db() as conn:
        contacts = conn.execute("SELECT name, phone FROM contacts").fetchall()

    sent, failed, details = 0, 0, []
    for contact in contacts:
        try:
            result = twilio_client.messages.create(
                body=message, from_=TWILIO_SMS_FROM, to=contact["phone"].strip()
            )
            sent += 1
            details.append({"name": contact["name"], "status": "submitted",
                            "sid": result.sid})
        except Exception:
            failed += 1
            # Avoid returning sensitive credentials or detailed errors.
            details.append({"name": contact["name"], "status": "failed"})

    return {"sent": sent, "failed": failed, "details": details}


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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)

        # Migrate an existing SafeRoute database safely.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(alerts)")}
        if "attempt_count" not in columns:
            conn.execute("ALTER TABLE alerts ADD COLUMN attempt_count "
                         "INTEGER NOT NULL DEFAULT 0")
        if "location" not in columns:
            conn.execute("ALTER TABLE alerts ADD COLUMN location TEXT DEFAULT ''")
        if "updated_at" not in columns:
            conn.execute("ALTER TABLE alerts ADD COLUMN updated_at TIMESTAMP")


init_db()


def load_settings(conn):
    settings = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        try:
            settings[row["key"]] = json.loads(row["value"])
        except ValueError:
            pass
    return settings


def set_status(conn, alert_id, status, only_open=True):
    where = f"AND status IN ({','.join('?' * len(OPEN_STATUSES))})" if only_open else ""
    params = [status, alert_id] + (list(OPEN_STATUSES) if only_open else [])
    return conn.execute(
        f"UPDATE alerts SET status = ?, updated_at = CURRENT_TIMESTAMP "
        f"WHERE id = ? {where}", params
    )


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "application": "SafeRoute"})


# DASHBOARD SUMMARY (restores UI state after a page reload)

@app.route("/api/summary")
def summary():
    with get_db() as conn:
        contacts = conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]
        open_alerts = conn.execute(
            f"SELECT * FROM alerts WHERE status IN "
            f"({','.join('?' * len(OPEN_STATUSES))}) ORDER BY id DESC",
            OPEN_STATUSES
        ).fetchall()
        recent = conn.execute(
            "SELECT * FROM alerts ORDER BY id DESC LIMIT 5"
        ).fetchall()
        settings = load_settings(conn)

    return jsonify({
        "contacts": contacts,
        "alerts_total": total,
        "open_alerts": [dict(r) for r in open_alerts],
        "recent": [dict(r) for r in recent],
        "police_configured": bool(settings.get("police")),
    })


# EMERGENCY CONTACTS

def read_contact_payload():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    phone = str(data.get("phone", "")).strip()
    relationship = str(data.get("relationship", "")).strip()

    if not name or not phone:
        return None, "Name and phone number are required."
    if len(name) > 100 or len(relationship) > 50:
        return None, "Name or relationship is too long."
    phone_error = validate_phone(phone)
    if phone_error:
        return None, phone_error
    return (name, phone, relationship), None


def phone_taken(conn, phone, exclude_id=None):
    target = normalize_phone(phone)
    for row in conn.execute("SELECT id, phone FROM contacts"):
        if row["id"] != exclude_id and normalize_phone(row["phone"]) == target:
            return True
    return False


@app.route("/api/contacts", methods=["GET"])
def get_contacts():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM contacts ORDER BY id DESC").fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/contacts", methods=["POST"])
def add_contact():
    payload, problem = read_contact_payload()
    if problem:
        return error(problem)
    name, phone, relationship = payload

    with get_db() as conn:
        if phone_taken(conn, phone):
            return error("A contact with this phone number already exists.", 409)
        cursor = conn.execute(
            "INSERT INTO contacts (name, phone, relationship) VALUES (?, ?, ?)",
            (name, phone, relationship)
        )

    return jsonify({"id": cursor.lastrowid, "name": name, "phone": phone,
                    "relationship": relationship,
                    "message": "Contact saved."}), 201


@app.route("/api/contacts/<int:contact_id>", methods=["PUT"])
def update_contact(contact_id):
    payload, problem = read_contact_payload()
    if problem:
        return error(problem)
    name, phone, relationship = payload

    with get_db() as conn:
        if phone_taken(conn, phone, exclude_id=contact_id):
            return error("A contact with this phone number already exists.", 409)
        cursor = conn.execute(
            "UPDATE contacts SET name = ?, phone = ?, relationship = ? WHERE id = ?",
            (name, phone, relationship, contact_id)
        )

    if cursor.rowcount == 0:
        return error("Contact not found.", 404)
    return jsonify({"id": contact_id, "name": name, "phone": phone,
                    "relationship": relationship})


@app.route("/api/contacts/<int:contact_id>", methods=["DELETE"])
def delete_contact(contact_id):
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    if cursor.rowcount == 0:
        return error("Contact not found.", 404)
    return jsonify({"message": "Contact deleted."})


# SETTINGS

@app.route("/api/settings", methods=["GET"])
def get_settings():
    with get_db() as conn:
        return jsonify(load_settings(conn))


@app.route("/api/settings", methods=["PUT"])
def save_settings():
    data = request.get_json(silent=True) or {}
    updates = {k: v for k, v in data.items() if k in DEFAULT_SETTINGS}

    for key, allowed in ALLOWED_SETTING_VALUES.items():
        if key in updates:
            try:
                updates[key] = int(updates[key])
            except (TypeError, ValueError):
                return error(f"Invalid value for {key}.")
            if updates[key] not in allowed:
                return error(f"Invalid value for {key}.")

    if "police" in updates:
        updates["police"] = str(updates["police"]).strip()
        police = updates["police"]
        # Emergency short codes like 100 / 112 are valid here.
        if police and not re.fullmatch(r"\+?[0-9\s\-()]{2,20}", police):
            return error("Enter a valid police number (digits only).")
        if police and not 2 <= len(re.sub(r"\D", "", police)) <= 15:
            return error("Enter a valid police number (digits only).")

    with get_db() as conn:
        conn.executemany(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(k, json.dumps(v)) for k, v in updates.items()]
        )
        return jsonify(load_settings(conn))


# ALERTS: accident, manual SOS, or health SOS

@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    alert_type = request.args.get("type", "").strip()
    limit = min(max(request.args.get("limit", 200, type=int), 1), 500)

    query, params = "SELECT * FROM alerts", []
    if alert_type in ALERT_TYPES:
        query += " WHERE alert_type = ?"
        params.append(alert_type)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/alerts", methods=["DELETE"])
def clear_alerts():
    with get_db() as conn:
        conn.execute("DELETE FROM alerts")
    return jsonify({"message": "Alert history cleared."})


@app.route("/api/alerts", methods=["POST"])
def create_alert():
    data = request.get_json(silent=True) or {}

    alert_type = str(data.get("alert_type", "demo")).strip()
    message = str(data.get("message", "Test alert")).strip()
    location = str(data.get("location", "")).strip()
    # 'logged' = informational record that needs no follow-up
    status = "logged" if data.get("status") == "logged" else "pending"

    if alert_type not in ALERT_TYPES:
        return error("Invalid alert type.")
    if not message:
        return error("Message is required.")
    if len(message) > 1000 or len(location) > 500:
        return error("Input is too long.")

    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO alerts (alert_type, message, location, status, attempt_count)
            VALUES (?, ?, ?, ?, 0)
        """, (alert_type, message, location, status))

    # This records an alert locally; it does NOT send a notification.
    return jsonify({"id": cursor.lastrowid, "status": status,
                    "message": "Alert recorded locally. No notification sent."}), 201


@app.route("/api/alerts/<int:alert_id>/cancel", methods=["POST"])
def cancel_alert(alert_id):
    with get_db() as conn:
        cursor = set_status(conn, alert_id, "cancelled")
    if cursor.rowcount == 0:
        return error("Alert not found or can no longer be cancelled.", 404)
    return jsonify({"id": alert_id, "status": "cancelled"})


@app.route("/api/alerts/resolve-all", methods=["POST"])
def resolve_all():
    with get_db() as conn:
        cursor = conn.execute(
            f"UPDATE alerts SET status = 'resolved', updated_at = CURRENT_TIMESTAMP "
            f"WHERE status IN ({','.join('?' * len(OPEN_STATUSES))})", OPEN_STATUSES
        )
    return jsonify({"resolved": cursor.rowcount})


@app.route("/api/alerts/<int:alert_id>/status", methods=["POST"])
def set_alert_status(alert_id):
    data = request.get_json(silent=True) or {}
    new_status = str(data.get("status", "")).strip()

    if new_status not in {"acknowledged", "send_failed", "resolved", "completed"}:
        return error("Invalid status.")

    with get_db() as conn:
        cursor = set_status(conn, alert_id, new_status)
    if cursor.rowcount == 0:
        return error("Alert not found or already closed.", 404)
    return jsonify({"id": alert_id, "status": new_status})


@app.route("/api/alerts/<int:alert_id>/retry", methods=["POST"])
def retry_alert(alert_id):
    with get_db() as conn:
        alert = conn.execute("SELECT * FROM alerts WHERE id = ?",
                             (alert_id,)).fetchone()
        if alert is None:
            return error("Alert not found.", 404)
        if alert["status"] not in OPEN_STATUSES:
            return error(f"Alert is already {alert['status']}.", 409)

        max_rounds = int(load_settings(conn).get("rounds") or 0)
        if max_rounds and alert["attempt_count"] >= max_rounds:
            set_status(conn, alert_id, "failed")
            return jsonify({"error": "Maximum round count reached.",
                            "attempts": alert["attempt_count"],
                            "status": "failed"}), 409

        new_attempt = alert["attempt_count"] + 1
        # Track a retry request only. No real message is sent.
        conn.execute("""
            UPDATE alerts SET attempt_count = ?, status = 'retry_queued',
                   updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (new_attempt, alert_id))

    return jsonify({"id": alert_id, "attempts": new_attempt,
                    "max_retries": max_rounds, "status": "retry_queued",
                    "message": "Retry recorded for simulation; no notification sent."})


if __name__ == "__main__":
    app.run(debug=True)

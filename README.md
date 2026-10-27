# SafeRoute

Accident alert console for an ESP32-based rider safety device (learning prototype).
Flask + SQLite backend, plain HTML/CSS/JS frontend.

> Demo mode: hardware is not connected and no SMS is sent (`ENABLE_REAL_ALERTS = False` in `app.py`).

## Features

- **Overview** – live status, open-alert banner, readiness checklist, recent activity
- **Manual SOS / Accident test / Health check** – simulated alert flows with cancel countdown, retry rounds and acknowledgement
- **Alert history** – filter by type or open alerts, resolve individual alerts
- **Contacts** – add, edit, remove emergency contacts (validated, no duplicates), police number
- **Location** – sample coordinates or your browser location
- **Settings** – countdown, number of rounds, retry interval
- Light / dark mode
- All data is stored in `data/saferoute.db` (created automatically on first run)

## Run on Windows

1. Install **Python 3.10+** from https://www.python.org/downloads/ – on the first installer screen tick **"Add python.exe to PATH"**.
2. Unzip the project (right-click → *Extract All*) and open the extracted `SafeRoute` folder in **VS Code** (*File → Open Folder*).
3. Open the terminal: **Terminal → New Terminal** (or <kbd>Ctrl</kbd>+<kbd>`</kbd>).
4. Create and activate a virtual environment:

   ```powershell
   python -m venv .venv
   .venv\Scripts\activate
   ```

   If PowerShell says *"running scripts is disabled on this system"*, run this once, then activate again:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

   (Command Prompt instead of PowerShell: use `.venv\Scripts\activate.bat`.)

5. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

6. Start the app:

   ```powershell
   python app.py
   ```

7. Open **http://127.0.0.1:5000** in your browser. Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

Next time you only need steps 4 (activate) and 6.

## Run on macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

On macOS, if port 5000 is busy (AirPlay Receiver), run `flask --app app run --port 5001`.

## Optional: SMS via Twilio

Create a `.env` file next to `app.py` (it is git-ignored – never commit it):

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_FROM=+1...
```

Then set `ENABLE_REAL_ALERTS = True` in `app.py`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `python` not recognised | Reinstall Python with "Add to PATH" ticked, then reopen VS Code |
| `ModuleNotFoundError: flask` | Activate the venv (step 4) before `pip install` / `python app.py` |
| Page looks old after an update | Hard refresh: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> |
| Want a fresh database | Stop the server and delete `data/saferoute.db` |

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/summary` | Dashboard counts, open and recent alerts |
| GET/POST | `/api/contacts` | List / add contact |
| PUT/DELETE | `/api/contacts/<id>` | Edit / remove contact |
| GET/PUT | `/api/settings` | Read / save settings |
| GET/POST/DELETE | `/api/alerts` | List (`?type=`) / create / clear alerts |
| POST | `/api/alerts/<id>/retry` | Next alert round (respects round limit) |
| POST | `/api/alerts/<id>/cancel` | Cancel an open alert |
| POST | `/api/alerts/<id>/status` | Set `acknowledged`, `send_failed` or `resolved` |
| POST | `/api/alerts/resolve-all` | Resolve every open alert |

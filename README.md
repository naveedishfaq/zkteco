# T Zync — Attendance

Standalone attendance dashboard for ZKTeco devices. Talks directly to the
device over its native protocol — no ZKBioTime dependency. SQLite storage,
no external database server required.

## Setup

```bash
npm install
"C:\Path\To\Python\python.exe" -m venv venv
venv\Scripts\pip.exe install -r requirements.txt
npm start
```

Open `http://localhost:3000` and follow the setup wizard to connect your device.

## Features

- Direct device sync (users + attendance punches)
- Daily / date-range attendance reports with CSV export
- Per-employee summaries and punch log
- Employee management (add / edit / deactivate / delete)
- Configurable shift, grace period, half-day threshold, timezone
- Device clock drift check
- Database backup / restore

Developed by the IT team & Naveed Ishfaq.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'attendance.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    department TEXT,
    position TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    shift_start TEXT,
    shift_end TEXT,
    grace_minutes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_name TEXT NOT NULL,
    device_ip TEXT UNIQUE NOT NULL,
    device_port INTEGER NOT NULL DEFAULT 4370,
    device_password INTEGER NOT NULL DEFAULT 0,
    device_model TEXT,
    serial_number TEXT,
    firmware_version TEXT,
    status TEXT NOT NULL DEFAULT 'Unknown',
    last_sync TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS device_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    punch_code INTEGER,
    punch_label TEXT,
    transaction_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(device_id, employee_id, transaction_time)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_txn_employee_time ON device_transactions(employee_id, transaction_time);
  CREATE INDEX IF NOT EXISTS idx_txn_time ON device_transactions(transaction_time);
`);

const DEFAULT_SETTINGS = {
  shift_start: '09:00',
  shift_end: '18:00',
  grace_minutes: '15',
  half_day_hours: '4',
  timezone: 'Asia/Karachi',
  brand_name: 'T Zync',
};

const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  insertSetting.run(key, value);
}

module.exports = { db, DB_PATH, DATA_DIR };

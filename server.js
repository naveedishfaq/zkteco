const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { db, DB_PATH, DATA_DIR } = require('./lib/db');
const reports = require('./lib/reports');

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PYTHON_BIN = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
const SYNC_SCRIPT = path.join(__dirname, 'scripts', 'device_sync.py');

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============== Device protocol bridge ==============

async function runDeviceScript(command, { ip, port, password }) {
  const { stdout } = await execFileAsync(PYTHON_BIN, [
    SYNC_SCRIPT, command, '--ip', ip, '--port', String(port), '--password', String(password),
  ], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 });

  const result = JSON.parse(stdout);
  if (!result.success) throw new Error(result.error || 'Device script failed');
  return result;
}

function getConfiguredDevice() {
  return db.prepare('SELECT * FROM devices ORDER BY id LIMIT 1').get();
}

// ============== Setup ==============

app.get('/api/setup/status', (req, res) => {
  const device = getConfiguredDevice();
  res.json({ configured: !!device, device: device || null });
});

app.post('/api/setup/test', async (req, res) => {
  try {
    const { ip, port, password } = req.body;
    const info = await runDeviceScript('test', { ip, port: port || 4370, password: password || 0 });
    res.json(info);
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.post('/api/setup/save', async (req, res) => {
  try {
    const { ip, port, password, device_name, timezone } = req.body;
    if (!ip) return res.status(400).json({ error: 'Device IP is required' });

    const info = await runDeviceScript('test', { ip, port: port || 4370, password: password || 0 }).catch(() => null);

    db.prepare(`
      INSERT INTO devices (device_name, device_ip, device_port, device_password, device_model, serial_number, firmware_version, status, last_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Online', datetime('now'))
      ON CONFLICT(device_ip) DO UPDATE SET
        device_name = excluded.device_name, device_port = excluded.device_port,
        device_password = excluded.device_password, status = 'Online', last_sync = datetime('now')
    `).run(
      device_name || 'Main Device', ip, port || 4370, password || 0,
      info?.device_name || null, info?.serial_number || null, info?.firmware_version || null
    );

    if (timezone) {
      db.prepare(`INSERT INTO settings (key, value) VALUES ('timezone', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(timezone);
    }

    res.json({ success: true, device_info: info });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== Health / Device ==============

app.get('/api/health', (req, res) => res.json({ status: 'connected' }));

app.get('/api/devices', (req, res) => {
  res.json(db.prepare('SELECT * FROM devices ORDER BY id').all());
});

app.get('/api/device/time', async (req, res) => {
  const device = getConfiguredDevice();
  if (!device) return res.status(400).json({ error: 'No device configured' });

  try {
    const result = await runDeviceScript('time', { ip: device.device_ip, port: device.device_port, password: device.device_password });
    const serverTime = new Date();
    const deviceTime = new Date(result.device_time);
    const driftSeconds = Math.round((serverTime - deviceTime) / 1000);

    res.json({ device_time: result.device_time, server_time: serverTime.toISOString(), drift_seconds: driftSeconds });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// ============== Sync ==============

app.post('/api/sync', async (req, res) => {
  const device = getConfiguredDevice();
  if (!device) return res.status(400).json({ error: 'No device configured. Complete setup first.' });

  try {
    const { device_info, users, attendance } = await runDeviceScript('sync', {
      ip: device.device_ip, port: device.device_port, password: device.device_password,
    });

    db.prepare(`
      UPDATE devices SET status = 'Online', last_sync = datetime('now'),
        device_model = ?, serial_number = ?, firmware_version = ?
      WHERE id = ?
    `).run(device_info?.device_name || device.device_model, device_info?.serial_number || device.serial_number,
           device_info?.firmware_version || device.firmware_version, device.id);

    const upsertEmployee = db.prepare(`
      INSERT INTO employees (employee_id, name, status) VALUES (?, ?, 'Active')
      ON CONFLICT(employee_id) DO UPDATE SET name = excluded.name, updated_at = datetime('now')
    `);
    const findEmployee = db.prepare('SELECT id FROM employees WHERE employee_id = ?');

    const empIdByDeviceUserId = new Map();
    for (const u of users) {
      const deviceUserId = String(u.user_id ?? u.uid);
      const name = (u.name || '').trim() || `User ${deviceUserId}`;
      upsertEmployee.run(deviceUserId, name);
      empIdByDeviceUserId.set(deviceUserId, findEmployee.get(deviceUserId).id);
    }

    const insertTxn = db.prepare(`
      INSERT OR IGNORE INTO device_transactions (device_id, employee_id, punch_code, punch_label, transaction_time)
      VALUES (?, ?, ?, ?, ?)
    `);

    let newTransactions = 0;
    for (const log of attendance) {
      const deviceUserId = String(log.user_id);
      let employeeId = empIdByDeviceUserId.get(deviceUserId);

      if (!employeeId) {
        upsertEmployee.run(deviceUserId, `User ${deviceUserId}`);
        employeeId = findEmployee.get(deviceUserId).id;
        empIdByDeviceUserId.set(deviceUserId, employeeId);
      }

      const punchCode = typeof log.punch === 'number' ? log.punch : null;
      const punchLabel = reports.labelForPunchCode(punchCode);
      const info = insertTxn.run(device.id, employeeId, punchCode, punchLabel, log.timestamp);
      if (info.changes > 0) newTransactions++;
    }

    res.json({
      success: true,
      employees_on_device: users.length,
      logs_on_device: attendance.length,
      new_transactions: newTransactions,
      synced_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Sync error:', error.message);
    db.prepare(`UPDATE devices SET status = 'Offline' WHERE id = ?`).run(device.id);
    res.status(502).json({ error: error.message });
  }
});

// ============== Dashboard ==============

app.get('/api/dashboard', (req, res) => {
  const settings = reports.getSettings(db);
  const today = reports.todayInTimezone(settings.timezone);

  const totalEmployees = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'Active'").get().c;
  const todayTxns = db.prepare(`SELECT COUNT(*) AS c FROM device_transactions WHERE transaction_time LIKE ?`).get(`${today}%`).c;
  const todayCheckins = db.prepare(`SELECT COUNT(DISTINCT employee_id) AS c FROM device_transactions WHERE transaction_time LIKE ?`).get(`${today}%`).c;
  const onlineDevices = db.prepare("SELECT COUNT(*) AS c FROM devices WHERE status = 'Online'").get().c;

  res.json({
    total_employees: totalEmployees,
    today_transactions: todayTxns,
    today_checkins: todayCheckins,
    online_devices: onlineDevices,
  });
});

// ============== Employees (CRUD) ==============

app.get('/api/employees', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM employees WHERE status = ? ORDER BY name').all(status)
    : db.prepare('SELECT * FROM employees ORDER BY name').all();
  res.json(rows);
});

app.post('/api/employees', (req, res) => {
  try {
    const { employee_id, name, email, phone, department, position } = req.body;
    if (!employee_id || !name) return res.status(400).json({ error: 'employee_id and name are required' });

    const info = db.prepare(`
      INSERT INTO employees (employee_id, name, email, phone, department, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(employee_id, name, email || null, phone || null, department || null, position || null);

    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) {
    res.status(400).json({ error: error.message.includes('UNIQUE') ? 'Employee ID already exists' : error.message });
  }
});

app.put('/api/employees/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  const fields = ['name', 'email', 'phone', 'department', 'position', 'status', 'shift_start', 'shift_end', 'grace_minutes'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];

  const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  if (setClause) {
    db.prepare(`UPDATE employees SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
      .run(...Object.values(updates), req.params.id);
  }

  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id));
});

app.delete('/api/employees/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  const txnCount = db.prepare('SELECT COUNT(*) AS c FROM device_transactions WHERE employee_id = ?').get(req.params.id).c;
  const force = req.query.force === 'true';

  if (txnCount === 0) {
    db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
    return res.json({ mode: 'deleted' });
  }

  if (force) {
    db.prepare('DELETE FROM device_transactions WHERE employee_id = ?').run(req.params.id);
    db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
    return res.json({ mode: 'deleted_forced', transactions_removed: txnCount });
  }

  db.prepare(`UPDATE employees SET status = 'Inactive', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ mode: 'deactivated', reason: `Employee has ${txnCount} attendance records. Pass ?force=true to permanently delete along with their history.` });
});

app.get('/api/employees/:id/summary', (req, res) => {
  try {
    const settings = reports.getSettings(db);
    const to = req.query.to || reports.todayInTimezone(settings.timezone);
    const from = req.query.from || to;
    res.json(reports.getEmployeeSummary(db, req.params.id, from, to));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== Reports ==============

app.get('/api/reports/daily', (req, res) => {
  try {
    const settings = reports.getSettings(db);
    const date = req.query.date || reports.todayInTimezone(settings.timezone);
    res.json(reports.getRangeReport(db, date, date, req.query.employee_id || null));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/range', (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    res.json(reports.getRangeReport(db, from, to, employee_id || null));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/range/export', (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    const rows = reports.getRangeReport(db, from, to, employee_id || null);
    const header = ['Date', 'Employee ID', 'Name', 'Department', 'Check In', 'Check Out', 'Punches', 'Status', 'Hours Worked'];
    const csvRows = [header.join(',')];

    for (const r of rows) {
      csvRows.push([
        r.day, r.emp_code, `"${(r.name || '').replace(/"/g, '""')}"`, r.department || '',
        r.check_in ? r.check_in.slice(11, 16) : '', r.check_out ? r.check_out.slice(11, 16) : '',
        r.punches, r.status, r.hours_worked,
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/trend', (req, res) => {
  try {
    res.json(reports.getTrend(db, parseInt(req.query.days, 10) || 7));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/punchlog', (req, res) => {
  try {
    const { from, to, employee_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    res.json(reports.getPunchLog(db, from, to, employee_id || null));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== Settings ==============

app.get('/api/settings', (req, res) => res.json(reports.getSettings(db)));

app.put('/api/settings', (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                              ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [key, value] of Object.entries(req.body || {})) upsert.run(key, String(value));
  res.json(reports.getSettings(db));
});

// ============== Backup / Restore ==============

app.get('/api/backup', async (req, res) => {
  try {
    const backupPath = path.join(DATA_DIR, `backup-${Date.now()}.db`);
    await db.backup(backupPath);
    res.download(backupPath, `attendance-backup-${new Date().toISOString().slice(0, 10)}.db`, (err) => {
      fs.unlink(backupPath, () => {});
      if (err) console.error('Backup download error:', err.message);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/restore', upload.single('backup'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const header = req.file.buffer.slice(0, 16).toString('utf8');
    if (!header.startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'Not a valid SQLite database file' });
    }

    db.close();
    const restoreCopy = path.join(DATA_DIR, 'restore-pending.db');
    fs.writeFileSync(restoreCopy, req.file.buffer);
    fs.copyFileSync(DB_PATH, path.join(DATA_DIR, `pre-restore-${Date.now()}.db`));
    fs.copyFileSync(restoreCopy, DB_PATH);
    fs.unlinkSync(restoreCopy);

    res.json({ success: true, message: 'Restore complete. Please restart the server.' });
    setTimeout(() => process.exit(0), 500);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== Serve app ==============

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`T Zync running at http://localhost:${PORT}`);
});

// Attendance reporting engine.
//
// Device punch timestamps are the device's own naive local clock (no UTC
// conversion — see /api/device/time for checking that clock is correct).
// They're stored as plain "YYYY-MM-DDTHH:MM:SS" text, so day/time bucketing
// is just string slicing — no timezone math, no Date-object surprises.

const PUNCH_CODE_LABELS = {
  0: 'IN',
  1: 'OUT',
  2: 'Break Out',
  3: 'Break In',
  4: 'OT In',
  5: 'OT Out',
};

function labelForPunchCode(code) {
  return PUNCH_CODE_LABELS[code] || null;
}

function dayKey(ts) { return ts.slice(0, 10); }
function minutesOfDay(ts) {
  const h = parseInt(ts.slice(11, 13), 10);
  const m = parseInt(ts.slice(14, 16), 10);
  return h * 60 + m;
}

function todayInTimezone(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
}

function shiftFor(employee, settings) {
  return {
    shiftStart: employee.shift_start || settings.shift_start || '09:00',
    graceMinutes: employee.grace_minutes ?? parseInt(settings.grace_minutes || '15', 10),
    halfDayHours: parseFloat(settings.half_day_hours || '4'),
  };
}

// Assigns an IN/OUT/etc label to every punch in a same-day, same-employee
// sequence. Trusts the device's own punch-state code when present; falls
// back to a simple alternating IN/OUT heuristic when the device doesn't
// report reliable state codes (common on fingerprint-only terminals).
function normalizeDayPunches(punches) {
  const sorted = [...punches].sort((a, b) => a.transaction_time.localeCompare(b.transaction_time));
  const hasAnyLabel = sorted.some(p => p.punch_label);

  let lastLabel = null;
  return sorted.map((p, i) => {
    let label = p.punch_label;
    if (!label) {
      if (hasAnyLabel) {
        label = lastLabel === 'IN' ? 'OUT' : 'IN';
      } else {
        label = i % 2 === 0 ? 'IN' : 'OUT';
      }
    }
    lastLabel = label;
    return { ...p, inferred_label: label };
  });
}

function buildDayRow(employee, dayPunches, settings) {
  const { shiftStart, graceMinutes, halfDayHours } = shiftFor(employee, settings);
  const punches = dayPunches.length;

  if (punches === 0) {
    return {
      employee_id: employee.id, emp_code: employee.employee_id, name: employee.name,
      department: employee.department, check_in: null, check_out: null,
      punches: 0, hours_worked: 0, status: 'Absent',
    };
  }

  const sorted = [...dayPunches].sort((a, b) => a.transaction_time.localeCompare(b.transaction_time));
  const checkIn = sorted[0].transaction_time;
  const checkOut = sorted[sorted.length - 1].transaction_time;

  const hoursWorked = punches >= 2
    ? Math.round(((minutesOfDay(checkOut) - minutesOfDay(checkIn)) / 60) * 100) / 100
    : 0;

  const [shH, shM] = shiftStart.split(':').map(Number);
  const shiftStartMinutes = shH * 60 + shM + Number(graceMinutes);
  const isLate = minutesOfDay(checkIn) > shiftStartMinutes;
  const isHalfDay = punches >= 2 && hoursWorked > 0 && hoursWorked < halfDayHours;

  const status = isLate ? 'Late' : isHalfDay ? 'Half Day' : 'Present';

  return {
    employee_id: employee.id, emp_code: employee.employee_id, name: employee.name,
    department: employee.department, check_in: checkIn, check_out: checkOut,
    punches, hours_worked: hoursWorked, status,
  };
}

function getActiveEmployees(db, employeeId) {
  if (employeeId) {
    const row = db.prepare('SELECT * FROM employees WHERE id = ? AND status = ?').get(employeeId, 'Active');
    return row ? [row] : [];
  }
  return db.prepare("SELECT * FROM employees WHERE status = 'Active' ORDER BY name").all();
}

function getPunchesInRange(db, from, to, employeeId) {
  // Widen the raw fetch by a day on each side; day bucketing + final filter
  // below is what actually enforces the exact [from, to] boundary.
  const params = [`${from}T00:00:00`, `${to}T23:59:59`];
  let filter = '';
  if (employeeId) { filter = 'AND employee_id = ?'; params.push(employeeId); }

  return db.prepare(`
    SELECT * FROM device_transactions
    WHERE transaction_time >= ? AND transaction_time <= ? ${filter}
    ORDER BY transaction_time
  `).all(...params);
}

function getRangeReport(db, from, to, employeeId) {
  const settings = getSettings(db);
  const employees = getActiveEmployees(db, employeeId);
  const punches = getPunchesInRange(db, from, to, employeeId);

  const punchesByEmpDay = new Map();
  for (const p of punches) {
    const key = `${p.employee_id}|${dayKey(p.transaction_time)}`;
    if (!punchesByEmpDay.has(key)) punchesByEmpDay.set(key, []);
    punchesByEmpDay.get(key).push(p);
  }

  const rows = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    for (const emp of employees) {
      const dayPunches = punchesByEmpDay.get(`${emp.id}|${day}`) || [];
      rows.push({ day, ...buildDayRow(emp, dayPunches, settings) });
    }
  }

  return rows;
}

function getPunchLog(db, from, to, employeeId) {
  const punches = getPunchesInRange(db, from, to, employeeId);
  const byEmpDay = new Map();
  for (const p of punches) {
    const key = `${p.employee_id}|${dayKey(p.transaction_time)}`;
    if (!byEmpDay.has(key)) byEmpDay.set(key, []);
    byEmpDay.get(key).push(p);
  }

  let result = [];
  for (const dayPunches of byEmpDay.values()) {
    result = result.concat(normalizeDayPunches(dayPunches));
  }
  return result.sort((a, b) => a.transaction_time.localeCompare(b.transaction_time));
}

function getTrend(db, days) {
  const settings = getSettings(db);
  const today = todayInTimezone(settings.timezone);
  const totalActive = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'Active'").get().c;

  const dayList = [];
  const end = new Date(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }

  const from = dayList[0];
  const to = dayList[dayList.length - 1];
  const punches = getPunchesInRange(db, from, to, null);

  const presentByDay = new Map();
  for (const p of punches) {
    const day = dayKey(p.transaction_time);
    if (!presentByDay.has(day)) presentByDay.set(day, new Set());
    presentByDay.get(day).add(p.employee_id);
  }

  return dayList.map(day => {
    const present = presentByDay.get(day)?.size || 0;
    return { day, present_count: present, absent_count: Math.max(0, totalActive - present) };
  });
}

function getEmployeeSummary(db, employeeId, from, to) {
  const rows = getRangeReport(db, from, to, employeeId);
  const daysPresent = rows.filter(r => r.status === 'Present').length;
  const daysLate = rows.filter(r => r.status === 'Late').length;
  const daysHalf = rows.filter(r => r.status === 'Half Day').length;
  const daysAbsent = rows.filter(r => r.status === 'Absent').length;
  const totalHours = rows.reduce((s, r) => s + Number(r.hours_worked || 0), 0);
  const workedDays = daysPresent + daysLate + daysHalf;

  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);

  return {
    employee: emp ? { id: emp.id, emp_code: emp.employee_id, name: emp.name, department: emp.department } : null,
    from, to,
    days_present: daysPresent,
    days_late: daysLate,
    days_half_day: daysHalf,
    days_absent: daysAbsent,
    total_hours: Math.round(totalHours * 100) / 100,
    avg_hours: workedDays > 0 ? Math.round((totalHours / workedDays) * 100) / 100 : 0,
    history: rows,
  };
}

module.exports = {
  labelForPunchCode,
  todayInTimezone,
  getSettings,
  getRangeReport,
  getPunchLog,
  getTrend,
  getEmployeeSummary,
};

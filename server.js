const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { db, seed } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('Set JWT_SECRET in production.'); process.exit(1);
}
seed();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves the portal page at /

// ---------- helpers ----------
const wrap = fn => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const audit = (uid, action, detail) =>
  db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES (?,?,?)').run(uid, action, detail || null);
const todayStr = () => new Date().toISOString().slice(0, 10);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.replace('Bearer ', ''), SECRET);
    const u = db.prepare('SELECT id,name,email,role,department_id FROM users WHERE id=? AND active=1').get(p.id);
    if (!u) return bad(res, 'Account disabled', 401);
    req.user = u; next();
  } catch { bad(res, 'Please log in', 401); }
}
const only = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : bad(res, 'Not allowed for your role', 403);
const teamIds = u =>
  u.role === 'HR' ? db.prepare('SELECT id FROM users WHERE active=1').all().map(r => r.id)
    : db.prepare('SELECT id FROM users WHERE manager_id=? AND active=1').all(u.id).map(r => r.id);

// ---------- auth ----------
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    audit(null, 'login_failed', email); return bad(res, 'Wrong email or password', 401);
  }
  audit(u.id, 'login');
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '8h' }),
    user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));
app.use('/api', (req, res, next) => req.path === '/auth/login' || req.path === '/health' ? next() : auth(req, res, next));
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => res.json(req.user));

// ---------- leave & payroll ----------
app.get('/api/leave/balance', (req, res) =>
  res.json(db.prepare('SELECT type,days FROM leave_balances WHERE user_id=?').all(req.user.id)));
app.get('/api/leave/mine', (req, res) =>
  res.json(db.prepare('SELECT * FROM leave_requests WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/leave', wrap((req, res) => {
  const { type, days, reason } = req.body || {};
  const bal = db.prepare('SELECT days FROM leave_balances WHERE user_id=? AND type=?').get(req.user.id, type);
  if (!bal) return bad(res, 'Unknown leave type');
  if (!(days > 0 && days <= 30)) return bad(res, 'Days must be between 1 and 30');
  if (days > bal.days) return bad(res, `Only ${bal.days} ${type} days left`);
  const r = db.prepare('INSERT INTO leave_requests(user_id,type,days,reason) VALUES (?,?,?,?)')
    .run(req.user.id, type, days, reason || null);
  audit(req.user.id, 'leave_requested', `${type} ${days}d`);
  res.status(201).json({ id: r.lastInsertRowid });
}));
app.get('/api/leave/pending', only('Manager', 'HR'), (req, res) => {
  const ids = teamIds(req.user).filter(i => i !== req.user.id);
  if (!ids.length) return res.json([]);
  res.json(db.prepare(`SELECT l.*,u.name FROM leave_requests l JOIN users u ON u.id=l.user_id
    WHERE l.status='Pending' AND l.user_id IN (${ids.map(() => '?').join(',')})`).all(...ids));
});
app.patch('/api/leave/:id', only('Manager', 'HR'), wrap((req, res) => {
  const status = req.body && req.body.status;
  if (!['Approved', 'Rejected'].includes(status)) return bad(res, 'Status must be Approved or Rejected');
  const l = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!l || l.status !== 'Pending') return bad(res, 'Request not found or already decided', 404);
  if (l.user_id === req.user.id) return bad(res, 'You cannot approve your own leave', 403);
  if (!teamIds(req.user).includes(l.user_id)) return bad(res, 'Not your team member', 403);
  db.transaction(() => {
    db.prepare('UPDATE leave_requests SET status=?,decided_by=? WHERE id=?').run(status, req.user.id, l.id);
    if (status === 'Approved')
      db.prepare('UPDATE leave_balances SET days=days-? WHERE user_id=? AND type=?').run(l.days, l.user_id, l.type);
  })();
  audit(req.user.id, 'leave_' + status.toLowerCase(), `request ${l.id}`);
  res.json({ ok: true });
}));

// ---------- hybrid work ----------
const weekStart = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
app.get('/api/workplan', (req, res) =>
  res.json(db.prepare('SELECT date,location FROM work_plan WHERE user_id=? AND date>=? ORDER BY date')
    .all(req.user.id, weekStart(req.query.from || todayStr()))));
app.put('/api/workplan', wrap((req, res) => {
  const { date, location } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !['Office', 'WFH'].includes(location)) return bad(res, 'Need date and location (Office/WFH)');
  if (location === 'WFH') {
    const ws = weekStart(date), we = new Date(new Date(ws).getTime() + 6 * 864e5).toISOString().slice(0, 10);
    const n = db.prepare("SELECT COUNT(*) c FROM work_plan WHERE user_id=? AND location='WFH' AND date BETWEEN ? AND ? AND date<>?")
      .get(req.user.id, ws, we, date).c;
    if (n >= 3) return bad(res, 'Policy limit: maximum 3 WFH days per week');
  }
  db.prepare('INSERT INTO work_plan VALUES (?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET location=excluded.location')
    .run(req.user.id, date, location);
  res.json({ ok: true });
}));
app.get('/api/team/today', only('Manager', 'HR'), (req, res) => {
  const ids = teamIds(req.user); if (!ids.length) return res.json([]);
  res.json(db.prepare(`SELECT u.id,u.name,COALESCE(w.location,'Not set') location FROM users u
    LEFT JOIN work_plan w ON w.user_id=u.id AND w.date=? WHERE u.id IN (${ids.map(() => '?').join(',')})`).all(todayStr(), ...ids));
});

// ---------- performance ----------
app.get('/api/goals', (req, res) => res.json(db.prepare('SELECT * FROM goals WHERE user_id=?').all(req.user.id)));
app.post('/api/goals', wrap((req, res) => {
  if (!req.body || !req.body.title) return bad(res, 'Title required');
  const r = db.prepare('INSERT INTO goals(user_id,title) VALUES (?,?)').run(req.user.id, req.body.title);
  res.status(201).json({ id: r.lastInsertRowid });
}));
app.patch('/api/goals/:id', wrap((req, res) => {
  const p = Number(req.body && req.body.progress);
  if (!(p >= 0 && p <= 100)) return bad(res, 'Progress must be 0-100');
  const r = db.prepare('UPDATE goals SET progress=? WHERE id=? AND user_id=?').run(Math.round(p), req.params.id, req.user.id);
  r.changes ? res.json({ ok: true }) : bad(res, 'Goal not found', 404);
}));
app.post('/api/feedback', wrap((req, res) => {
  const { to_user, message } = req.body || {};
  if (!message || !db.prepare('SELECT 1 FROM users WHERE id=?').get(to_user)) return bad(res, 'Need valid to_user and message');
  db.prepare('INSERT INTO feedback(from_user,to_user,message) VALUES (?,?,?)').run(req.user.id, to_user, message);
  res.status(201).json({ ok: true });
}));
app.get('/api/feedback', (req, res) => res.json(db.prepare(
  'SELECT f.message,f.created_at,u.name from_name FROM feedback f JOIN users u ON u.id=f.from_user WHERE f.to_user=? ORDER BY f.id DESC').all(req.user.id)));

// ---------- hiring & onboarding ----------
app.get('/api/candidates', only('HR'), (_, res) => res.json(db.prepare('SELECT * FROM candidates').all()));
app.post('/api/candidates', only('HR'), wrap((req, res) => {
  const { name, role } = req.body || {}; if (!name || !role) return bad(res, 'Need name and role');
  res.status(201).json({ id: db.prepare('INSERT INTO candidates(name,role) VALUES (?,?)').run(name, role).lastInsertRowid });
}));
app.patch('/api/candidates/:id', only('HR'), wrap((req, res) => {
  const stage = req.body && req.body.stage;
  if (!['Applied', 'Screened', 'Interview', 'Offer', 'Hired', 'Rejected'].includes(stage)) return bad(res, 'Invalid stage');
  const r = db.prepare("UPDATE candidates SET stage=?,hired_on=CASE WHEN ?='Hired' THEN date('now') ELSE hired_on END WHERE id=?").run(stage, stage, req.params.id);
  if (!r.changes) return bad(res, 'Not found', 404);
  audit(req.user.id, 'candidate_stage', `${req.params.id} -> ${stage}`); res.json({ ok: true });
}));
app.get('/api/onboarding', (req, res) => {
  const uid = ['HR', 'Manager'].includes(req.user.role) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
  if (uid !== req.user.id && !teamIds(req.user).includes(uid)) return bad(res, 'Not allowed', 403);
  res.json(db.prepare('SELECT * FROM onboarding_tasks WHERE user_id=?').all(uid));
});
app.patch('/api/onboarding/:id', wrap((req, res) => {
  const t = db.prepare('SELECT * FROM onboarding_tasks WHERE id=?').get(req.params.id);
  if (!t) return bad(res, 'Not found', 404);
  if (t.user_id !== req.user.id && !(req.user.role !== 'Employee' && teamIds(req.user).includes(t.user_id))) return bad(res, 'Not allowed', 403);
  db.prepare('UPDATE onboarding_tasks SET done=? WHERE id=?').run(req.body && req.body.done ? 1 : 0, t.id);
  res.json({ ok: true });
}));

// ---------- engagement (anonymous pulse) ----------
app.post('/api/pulse', wrap((req, res) => {
  const mood = Number(req.body && req.body.mood);
  if (![1, 2, 3, 4].includes(mood)) return bad(res, 'Mood must be 1-4');
  const wk = weekStart(todayStr());
  // No user id is stored, so answers stay anonymous.
  db.prepare('INSERT INTO pulse_responses(department_id,mood,week) VALUES (?,?,?)').run(req.user.department_id, mood, wk);
  res.status(201).json({ ok: true });
}));
app.get('/api/pulse/summary', only('HR'), (_, res) => res.json(db.prepare(`
  SELECT d.name department, ROUND(AVG(p.mood)*25,0) score, COUNT(*) responses
  FROM pulse_responses p JOIN departments d ON d.id=p.department_id
  GROUP BY d.id HAVING COUNT(*)>=3`).all())); // hide groups under 3 to protect anonymity

// ---------- compliance, policies, helpdesk ----------
app.get('/api/compliance', (_, res) => res.json(db.prepare('SELECT * FROM compliance_items').all()));
app.patch('/api/compliance/:id', only('HR'), wrap((req, res) => {
  const p = Number(req.body && req.body.percent_done);
  if (!(p >= 0 && p <= 100)) return bad(res, '0-100 only');
  db.prepare('UPDATE compliance_items SET percent_done=? WHERE id=?').run(p, req.params.id);
  audit(req.user.id, 'compliance_updated', req.params.id); res.json({ ok: true });
}));
app.get('/api/policies', (req, res) => res.json(db.prepare(
  `SELECT p.*, (SELECT 1 FROM policy_acks a WHERE a.policy_id=p.id AND a.user_id=?) IS NOT NULL acknowledged FROM policies p`).all(req.user.id)));
app.post('/api/policies/:id/ack', wrap((req, res) => {
  if (!db.prepare('SELECT 1 FROM policies WHERE id=?').get(req.params.id)) return bad(res, 'Not found', 404);
  db.prepare('INSERT OR IGNORE INTO policy_acks(user_id,policy_id) VALUES (?,?)').run(req.user.id, req.params.id);
  audit(req.user.id, 'policy_ack', req.params.id); res.json({ ok: true });
}));
app.get('/api/tickets', (req, res) => res.json(req.user.role === 'HR'
  ? db.prepare('SELECT t.*,u.name FROM tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC').all()
  : db.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/tickets', wrap((req, res) => {
  const s = req.body && String(req.body.subject || '').trim(); if (!s) return bad(res, 'Subject required');
  res.status(201).json({ id: db.prepare('INSERT INTO tickets(user_id,subject) VALUES (?,?)').run(req.user.id, s).lastInsertRowid });
}));
app.patch('/api/tickets/:id', only('HR'), wrap((req, res) => {
  const s = req.body && req.body.status; if (!['Open', 'In progress', 'Resolved'].includes(s)) return bad(res, 'Invalid status');
  db.prepare('UPDATE tickets SET status=? WHERE id=?').run(s, req.params.id); res.json({ ok: true });
}));
app.post('/api/chat', wrap((req, res) => {
  const q = String((req.body && req.body.message) || '').toLowerCase();
  const bal = db.prepare('SELECT type,days FROM leave_balances WHERE user_id=?').all(req.user.id).map(b => `${b.days} ${b.type}`).join(', ');
  const reply = q.includes('leave') ? `Your balance: ${bal}. Apply under Leave.`
    : /payslip|salary/.test(q) ? 'Payslips are under Leave & Pay. If an amount looks wrong, raise a ticket.'
    : /wfh|remote/.test(q) ? 'You can work from home up to 3 days a week.'
    : q.includes('posh') ? 'See the POSH policy under Compliance. Complaints go to the Internal Committee.'
    : 'I am not sure. Please raise a ticket and HR will reply within 24 hours.';
  res.json({ reply });
}));

// ---------- HR analytics (HR only) ----------
function riskFor(u, deptScore) {
  let s = 10; const why = [];
  const months = (Date.now() - new Date(u.last_promotion_date || u.join_date)) / 2.63e9;
  if (months > 24) { s += 30; why.push(`No promotion in ${Math.round(months)} months`); } else if (months > 12) { s += 15; why.push('No promotion in over a year'); }
  const gap = u.market_salary_lakh ? (u.market_salary_lakh - u.salary_lakh) / u.market_salary_lakh : 0;
  if (gap > 0.05) { s += Math.min(30, Math.round(gap * 200)); why.push(`Pay ${Math.round(gap * 100)}% below market`); }
  if (deptScore != null && deptScore < 60) { s += 15; why.push('Low team engagement'); }
  if ((Date.now() - new Date(u.join_date)) / 2.63e9 < 12) { s += 10; why.push('First year at company'); }
  return { score: Math.min(99, s), reasons: why };
}
const deptScores = () => Object.fromEntries(db.prepare(
  'SELECT department_id d, AVG(mood)*25 s FROM pulse_responses GROUP BY department_id HAVING COUNT(*)>=3').all().map(r => [r.d, r.s]));
app.get('/api/analytics/attrition-risk', only('HR'), (req, res) => {
  const ds = deptScores();
  const out = db.prepare("SELECT * FROM users WHERE active=1 AND role<>'HR' OR (active=1 AND role='HR' AND manager_id IS NOT NULL)").all()
    .map(u => ({ id: u.id, name: u.name, job_title: u.job_title, ...riskFor(u, ds[u.department_id]) }))
    .sort((a, b) => b.score - a.score);
  audit(req.user.id, 'viewed_attrition_risk'); res.json(out);
});
app.post('/api/analytics/simulate', only('HR'), wrap((req, res) => {
  const { user_id, raise = 0, promotion, manager_change, flexible, learning } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user_id); if (!u) return bad(res, 'User not found', 404);
  const base = riskFor(u, deptScores()[u.department_id]).score;
  const after = Math.max(5, Math.round(base - raise * 1.6 - (promotion ? 18 : 0) - (manager_change ? 10 : 0) - (flexible ? 8 : 0) - (learning ? 6 : 0)));
  const mult = Number(req.body.replacement_cost_pct || 100) / 100;
  const avoided = (base - after) / 100 * u.salary_lakh * mult, extraPay = u.salary_lakh * raise / 100;
  res.json({ before: base, after, cost_avoided_lakh: +avoided.toFixed(2), extra_pay_lakh: +extraPay.toFixed(2), net_lakh: +(avoided - extraPay).toFixed(2) });
}));
app.get('/api/analytics/overview', only('HR'), (_, res) => {
  const head = db.prepare("SELECT COUNT(*) c FROM users WHERE active=1").get().c;
  const exits = db.prepare("SELECT COUNT(*) c FROM exits WHERE exit_date>=date('now','-12 months')").get().c;
  const ttf = db.prepare("SELECT AVG(julianday(hired_on)-julianday(applied_on)) d FROM candidates WHERE hired_on IS NOT NULL").get().d;
  const eng = db.prepare('SELECT AVG(mood)*25 s FROM pulse_responses').get().s;
  const ds = deptScores();
  const high = db.prepare("SELECT * FROM users WHERE active=1").all().filter(u => riskFor(u, ds[u.department_id]).score >= 70).length;
  res.json({ headcount: head, attrition_pct_12m: +(exits / head * 100).toFixed(1), avg_days_to_fill: ttf == null ? null : Math.round(ttf),
    engagement_score: eng == null ? null : Math.round(eng), high_risk_employees: high });
});
app.get('/api/audit', only('HR'), (_, res) => res.json(db.prepare(
  'SELECT a.*,u.name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all()));
app.get('/api/users', only('HR'), (_, res) => res.json(db.prepare(
  'SELECT id,name,email,role,job_title,department_id,manager_id,join_date,active FROM users').all()));

// ---------- errors ----------
app.use((req, res) => bad(res, 'Not found', 404));
app.use((err, req, res, next) => { console.error(err); bad(res, 'Server error', 500); });

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`HR API running on http://localhost:${port}`));
}
module.exports = app;

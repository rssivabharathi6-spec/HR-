PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL
);

-- One row per person who can log in. Role decides what they may access.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('HR','Manager','Employee')),
  department_id INTEGER REFERENCES departments(id),
  manager_id INTEGER REFERENCES users(id),
  job_title TEXT,
  join_date TEXT,
  salary_lakh REAL,            -- sensitive: only HR can read
  market_salary_lakh REAL,     -- used by attrition risk
  last_promotion_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS leave_balances (
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, days REAL NOT NULL,
  PRIMARY KEY (user_id, type)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, days REAL NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hybrid work plan: one row per user per date
CREATE TABLE IF NOT EXISTS work_plan (
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('Office','WFH')),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  cycle TEXT NOT NULL DEFAULT 'Q4'
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'Applied'
    CHECK (stage IN ('Applied','Screened','Interview','Offer','Hired','Rejected')),
  applied_on TEXT NOT NULL DEFAULT (date('now')), hired_on TEXT
);

CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  step TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
);

-- Weekly pulse survey. Anonymous: no user_id is stored, only department.
CREATE TABLE IF NOT EXISTS pulse_responses (
  id INTEGER PRIMARY KEY,
  department_id INTEGER REFERENCES departments(id),
  mood INTEGER NOT NULL CHECK (mood BETWEEN 1 AND 4),
  week TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY, title TEXT UNIQUE NOT NULL, version TEXT NOT NULL DEFAULT '1.0'
);
CREATE TABLE IF NOT EXISTS policy_acks (
  user_id INTEGER NOT NULL REFERENCES users(id),
  policy_id INTEGER NOT NULL REFERENCES policies(id),
  acked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, policy_id)
);

CREATE TABLE IF NOT EXISTS compliance_items (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL,
  percent_done INTEGER NOT NULL DEFAULT 0, due_date TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In progress','Resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  exit_date TEXT NOT NULL, reason TEXT
);

-- Who did what, and when (compliance requirement)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

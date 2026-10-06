-- سامانه ثبت و پیگیری شکایات - ساختار دیتابیس D1

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS cases (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_code           TEXT NOT NULL UNIQUE,
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  filed_for               TEXT NOT NULL CHECK (filed_for IN ('self','other')),
  complainant_name        TEXT NOT NULL,
  complainant_phone       TEXT NOT NULL,
  complainant_national_id TEXT,
  against_name            TEXT,
  category                TEXT NOT NULL CHECK (category IN ('services','financial','administrative','technical','behavior','other')),
  subject                 TEXT NOT NULL,
  description             TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewing','answered','closed','rejected')),
  signature               TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cases_user    ON cases(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_cases_status  ON cases(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_cases_created ON cases(created_at);

CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  message     TEXT,
  from_status TEXT,
  to_status   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'complaint_file' CHECK (kind IN ('complaint_file','petition')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        TEXT NOT NULL,           -- محتوای فایل به‌صورت Base64
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_case ON attachments(case_id);

CREATE TABLE IF NOT EXISTS notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id               INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  viewed_at             TEXT,
  confirmed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_case ON notifications(case_id);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  details     TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_admin   ON admin_audit_logs(admin_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, created_at);

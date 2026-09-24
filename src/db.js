import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Each entry is one schema version. Append new entries; never edit old ones.
const MIGRATIONS = [
  `
  CREATE TABLE schools (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    teams_webhook_url TEXT,
    teams_enabled INTEGER NOT NULL DEFAULT 1,
    teams_include_reason INTEGER NOT NULL DEFAULT 1,
    teams_last_status TEXT,
    teams_last_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','director','secretary','teacher')),
    username TEXT NOT NULL COLLATE NOCASE,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    employee_number TEXT,
    position TEXT,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (school_id, username)
  );
  CREATE INDEX users_school ON users(school_id, role);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user','platform')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE absences (
    id INTEGER PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    partial INTEGER NOT NULL DEFAULT 0,
    start_time TEXT,
    end_time TEXT,
    category TEXT,
    reason TEXT,
    coverage_notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
    received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    received_at TEXT,
    substitute TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX absences_school_dates ON absences(school_id, start_date, end_date);
  CREATE INDEX absences_user ON absences(user_id, start_date);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    absence_id INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX attachments_absence ON attachments(absence_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    absence_id INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX comments_absence ON comments(absence_id);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX notifications_user ON notifications(user_id, read_at);

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'leap.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, STAFF_ROLES, MANAGER_ROLES } from './util.js';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

export const SESSION_COOKIE = 'lah_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Used to keep login timing similar when the user does not exist.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(String(password || ''), dummyHash);
}

export function safeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function createSession(db, config, res, req, { kind, userId = null }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, kind, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    kind,
    userId,
    expires.toISOString(),
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    expires,
  });
}

export function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function sessionMiddleware(db, config) {
  const find = db.prepare(`
    SELECT s.token_hash, s.kind, s.expires_at,
           u.id AS user_id, u.school_id, u.role, u.username, u.full_name, u.email, u.phone,
           u.position, u.employee_number, u.must_change_password, u.active AS user_active,
           sc.code AS school_code, sc.name AS school_name, sc.active AS school_active
    FROM sessions s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN schools sc ON sc.id = u.school_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);
  const extend = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');

  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return next();
    const row = find.get(hashToken(token), new Date().toISOString());
    if (!row) return next();
    req.sessionId = row.token_hash;

    if (row.kind === 'platform') {
      req.platform = true;
    } else if (row.user_id && row.user_active && row.school_active) {
      req.user = {
        id: row.user_id,
        school_id: row.school_id,
        role: row.role,
        username: row.username,
        full_name: row.full_name,
        email: row.email,
        phone: row.phone,
        position: row.position,
        employee_number: row.employee_number,
        must_change_password: !!row.must_change_password,
      };
      req.school = { id: row.school_id, code: row.school_code, name: row.school_name };
    } else {
      return next();
    }

    // Sliding expiration: extend when less than half of the lifetime remains.
    const remaining = new Date(row.expires_at).getTime() - Date.now();
    if (remaining < (config.sessionDays * 86400000) / 2) {
      const expires = new Date(Date.now() + config.sessionDays * 86400000);
      extend.run(expires.toISOString(), row.token_hash);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', expires });
    }
    next();
  };
}

/**
 * Requires a logged-in school user. Pass roles to restrict further.
 * Users that must change their password can only reach routes marked allowPasswordChange.
 */
export function requireUser(roles = null, { allowPasswordChange = false } = {}) {
  return (req, res, next) => {
    if (!req.user) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
    if (req.user.must_change_password && !allowPasswordChange) {
      throw new HttpError(403, 'Debes cambiar tu contraseña antes de continuar.');
    }
    if (roles && !roles.includes(req.user.role)) {
      throw new HttpError(403, 'No tienes permiso para realizar esta acción.');
    }
    next();
  };
}

export const requireStaff = () => requireUser(STAFF_ROLES);
export const requireManager = () => requireUser(MANAGER_ROLES);

export function requirePlatform(req, res, next) {
  if (!req.platform) throw new HttpError(401, 'Sesión de plataforma requerida.');
  next();
}

/** Simple in-memory limiter for login attempts. */
export function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (entry && now - entry.first < windowMs && entry.count >= max) {
        throw new HttpError(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      }
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.first >= windowMs) hits.set(key, { first: now, count: 1 });
      else entry.count++;
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (now - v.first >= windowMs) hits.delete(k);
      }
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

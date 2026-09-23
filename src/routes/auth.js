import { Router } from 'express';
import {
  burnPasswordCheck,
  createLoginLimiter,
  createSession,
  destroySession,
  hashPassword,
  requireUser,
  safeEqualStrings,
  verifyPassword,
} from '../auth.js';
import { nowIso } from '../db.js';
import { HttpError, normalizeSchoolCode, validatePassword, ROLE_LABELS } from '../util.js';

export function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    role_label: ROLE_LABELS[user.role],
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    position: user.position,
    employee_number: user.employee_number,
    must_change_password: !!user.must_change_password,
  };
}

export default function authRoutes({ db, config }) {
  const router = Router();
  const limiter = createLoginLimiter();

  const findSchool = db.prepare('SELECT id, code, name, active FROM schools WHERE code = ?');
  const findUser = db.prepare('SELECT * FROM users WHERE school_id = ? AND username = ? AND active = 1');
  const findAdmin = db.prepare("SELECT * FROM users WHERE school_id = ? AND role = 'admin' AND active = 1");
  const touchLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');

  async function login(req, res, { schoolCode, password, lookup }) {
    const code = normalizeSchoolCode(schoolCode);
    if (!code || !password) throw new HttpError(400, 'Completa todos los campos.');
    const key = `${req.ip}|${code}`;
    limiter.check(key);

    const school = findSchool.get(code);
    const user = school?.active ? lookup(school) : null;
    const valid = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
    if (!valid) {
      limiter.fail(key);
      throw new HttpError(401, 'Código de escuela, usuario o contraseña incorrectos.');
    }
    limiter.reset(key);
    touchLogin.run(nowIso(), user.id);
    createSession(db, config, res, req, { kind: 'user', userId: user.id });
    res.json({ user: publicUser(user), school: { code: school.code, name: school.name } });
  }

  // Staff/teacher login: school code + username + password.
  router.post('/login', (req, res) => {
    const { school_code, username, password } = req.body || {};
    const name = String(username || '').trim();
    if (!name) throw new HttpError(400, 'Completa todos los campos.');
    return login(req, res, { schoolCode: school_code, password, lookup: (s) => findUser.get(s.id, name) });
  });

  // School administration login: school code + admin password only.
  router.post('/admin-login', (req, res) => {
    const { school_code, password } = req.body || {};
    return login(req, res, { schoolCode: school_code, password, lookup: (s) => findAdmin.get(s.id) });
  });

  router.post('/platform-login', (req, res) => {
    if (!config.platformPassword) {
      throw new HttpError(403, 'El panel de plataforma está deshabilitado. Define PLATFORM_ADMIN_PASSWORD en el servidor.');
    }
    const key = `${req.ip}|__platform__`;
    limiter.check(key);
    const { password } = req.body || {};
    if (!password || !safeEqualStrings(password, config.platformPassword)) {
      limiter.fail(key);
      throw new HttpError(401, 'Contraseña incorrecta.');
    }
    limiter.reset(key);
    createSession(db, config, res, req, { kind: 'platform' });
    res.json({ platform: true });
  });

  router.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  return router;
}

export function meRoutes({ db }) {
  const router = Router();
  const getHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
  const setPassword = db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
  );
  const updateProfile = db.prepare('UPDATE users SET email = ?, phone = ?, updated_at = ? WHERE id = ?');

  router.get('/', (req, res) => {
    if (req.platform) return res.json({ platform: true });
    // Not an error: the app asks this on startup to know whether to show the login screen.
    if (!req.user) return res.json({ user: null });
    res.json({ user: publicUser(req.user), school: { code: req.school.code, name: req.school.name } });
  });

  router.post('/password', requireUser(null, { allowPasswordChange: true }), async (req, res) => {
    const { current_password, new_password } = req.body || {};
    const row = getHash.get(req.user.id);
    if (!(await verifyPassword(String(current_password || ''), row.password_hash))) {
      throw new HttpError(400, 'La contraseña actual no es correcta.');
    }
    validatePassword(new_password);
    if (new_password === current_password) throw new HttpError(400, 'La nueva contraseña debe ser diferente.');
    const hash = await hashPassword(new_password);
    db.transaction(() => {
      setPassword.run(hash, nowIso(), req.user.id);
      // Sign out other devices.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, req.sessionId);
    })();
    res.json({ ok: true });
  });

  router.patch('/', requireUser(), (req, res) => {
    const { email, phone } = req.body || {};
    const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
    updateProfile.run(clean(email, 200), clean(phone, 40), nowIso(), req.user.id);
    res.json({ ok: true });
  });

  return router;
}

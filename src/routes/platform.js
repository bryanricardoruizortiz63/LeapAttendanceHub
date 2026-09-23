import crypto from 'node:crypto';
import { Router } from 'express';
import { hashPassword, requirePlatform } from '../auth.js';
import { nowIso } from '../db.js';
import { HttpError, bool, normalizeSchoolCode, reqText, validatePassword, validateSchoolCode } from '../util.js';

/** Suggests a readable code from the school name, e.g. "Leap Academy" -> "LA-4821". */
function suggestCode(name, exists) {
  const initials = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-Z]/.test(w))
    .map((w) => w[0].toUpperCase())
    .join('')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6) || 'ESC';
  for (let i = 0; i < 50; i++) {
    const code = `${initials.padEnd(2, 'X')}-${crypto.randomInt(1000, 10000)}`;
    if (!exists(code)) return code;
  }
  throw new HttpError(500, 'No se pudo generar un código único.');
}

export async function createSchool(db, { code, name, adminPassword }) {
  const exists = (c) => !!db.prepare('SELECT 1 FROM schools WHERE code = ?').get(c);
  const schoolName = reqText(name, 150, 'El nombre de la escuela');
  const finalCode = code ? normalizeSchoolCode(code) : suggestCode(schoolName, exists);
  validateSchoolCode(finalCode);
  if (exists(finalCode)) throw new HttpError(409, 'Ya existe una escuela con ese código.');
  validatePassword(adminPassword);
  const hash = await hashPassword(adminPassword);
  return db.transaction(() => {
    const info = db.prepare('INSERT INTO schools (code, name) VALUES (?, ?)').run(finalCode, schoolName);
    db.prepare(
      "INSERT INTO users (school_id, role, username, full_name, password_hash) VALUES (?, 'admin', 'admin', 'Administración', ?)",
    ).run(info.lastInsertRowid, hash);
    return { id: Number(info.lastInsertRowid), code: finalCode, name: schoolName };
  })();
}

export default function platformRoutes({ db }) {
  const router = Router();
  router.use(requirePlatform);

  const list = db.prepare(`
    SELECT s.id, s.code, s.name, s.active, s.created_at, s.teams_webhook_url IS NOT NULL AS has_teams,
      (SELECT COUNT(*) FROM users u WHERE u.school_id = s.id AND u.role != 'admin' AND u.active = 1) AS employees,
      (SELECT COUNT(*) FROM absences a WHERE a.school_id = s.id) AS absences,
      (SELECT MAX(a.created_at) FROM absences a WHERE a.school_id = s.id) AS last_absence_at
    FROM schools s ORDER BY s.created_at DESC
  `);

  router.get('/schools', (req, res) => res.json({ schools: list.all() }));

  router.post('/schools', async (req, res) => {
    const { code, name, admin_password } = req.body || {};
    const school = await createSchool(db, { code, name, adminPassword: admin_password });
    res.status(201).json({ school });
  });

  router.patch('/schools/:id', (req, res) => {
    const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(Number(req.params.id));
    if (!school) throw new HttpError(404, 'Escuela no encontrada.');
    const b = req.body || {};
    const name = 'name' in b ? reqText(b.name, 150, 'El nombre') : school.name;
    const active = 'active' in b ? (bool(b.active) ? 1 : 0) : school.active;
    db.prepare('UPDATE schools SET name = ?, active = ? WHERE id = ?').run(name, active, school.id);
    res.json({ ok: true });
  });

  router.post('/schools/:id/admin-password', async (req, res) => {
    const admin = db
      .prepare("SELECT id FROM users WHERE school_id = ? AND role = 'admin'")
      .get(Number(req.params.id));
    if (!admin) throw new HttpError(404, 'Escuela no encontrada.');
    validatePassword(req.body?.password);
    const hash = await hashPassword(req.body.password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), admin.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
    })();
    res.json({ ok: true });
  });

  return router;
}

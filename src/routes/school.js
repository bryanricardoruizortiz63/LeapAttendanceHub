import { Router } from 'express';
import { hashPassword, requireManager, requireUser, verifyPassword } from '../auth.js';
import { nowIso } from '../db.js';
import { buildCard, validateTeamsUrl } from '../teams.js';
import { HttpError, bool, isManager, reqText, validatePassword } from '../util.js';

export default function schoolRoutes({ db, config, notifier }) {
  const router = Router();
  const getSchool = db.prepare('SELECT * FROM schools WHERE id = ?');

  function view(school, full) {
    const base = { code: school.code, name: school.name };
    if (!full) return base;
    return {
      ...base,
      teams_webhook_url: school.teams_webhook_url,
      teams_enabled: !!school.teams_enabled,
      teams_include_reason: !!school.teams_include_reason,
      teams_last_status: school.teams_last_status,
      teams_last_at: school.teams_last_at,
      created_at: school.created_at,
    };
  }

  router.get('/', requireUser(), (req, res) => {
    res.json({ school: view(getSchool.get(req.user.school_id), isManager(req.user)) });
  });

  router.patch('/', requireManager(), (req, res) => {
    const b = req.body || {};
    const school = getSchool.get(req.user.school_id);
    const name = 'name' in b ? reqText(b.name, 150, 'El nombre de la escuela') : school.name;
    const url = 'teams_webhook_url' in b ? validateTeamsUrl(b.teams_webhook_url, config) : school.teams_webhook_url;
    const enabled = 'teams_enabled' in b ? (bool(b.teams_enabled) ? 1 : 0) : school.teams_enabled;
    const includeReason = 'teams_include_reason' in b ? (bool(b.teams_include_reason) ? 1 : 0) : school.teams_include_reason;
    const urlChanged = url !== school.teams_webhook_url;
    db.prepare(
      `UPDATE schools SET name = ?, teams_webhook_url = ?, teams_enabled = ?, teams_include_reason = ?
         ${urlChanged ? ', teams_last_status = NULL, teams_last_at = NULL' : ''}
       WHERE id = ?`,
    ).run(name, url, enabled, includeReason, school.id);
    res.json({ school: view(getSchool.get(school.id), true) });
  });

  router.post('/test-teams', requireManager(), async (req, res) => {
    const school = getSchool.get(req.user.school_id);
    if (!school.teams_webhook_url) throw new HttpError(400, 'Primero guarda la URL del webhook de Teams.');
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const result = await notifier.sendTeams(
      school.id,
      buildCard({
        title: '✅ Prueba de Leap Attendance Hub',
        subtitle: school.name,
        text: `Las nuevas ausencias del personal se publicarán en este canal. Prueba enviada por ${req.user.full_name}.`,
        linkUrl: `${base}/`,
      }),
    );
    if (result.skipped) throw new HttpError(400, 'Las notificaciones de Teams están desactivadas.');
    if (!result.ok) throw new HttpError(502, `No se pudo enviar a Teams: ${result.error}`);
    res.json({ ok: true, school: view(getSchool.get(school.id), true) });
  });

  router.post('/admin-password', requireManager(), async (req, res) => {
    const { current_password, new_password } = req.body || {};
    const admin = db.prepare("SELECT id, password_hash FROM users WHERE school_id = ? AND role = 'admin'").get(req.user.school_id);
    if (!admin || !(await verifyPassword(String(current_password || ''), admin.password_hash))) {
      throw new HttpError(400, 'La contraseña de administración actual no es correcta.');
    }
    validatePassword(new_password);
    const hash = await hashPassword(new_password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), admin.id);
      // Sign out every other admin session (the current one survives if it is the admin itself).
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(admin.id, req.sessionId);
    })();
    res.json({ ok: true });
  });

  return router;
}

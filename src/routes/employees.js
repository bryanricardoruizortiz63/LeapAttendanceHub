import { Router } from 'express';
import { hashPassword, requireManager, requireStaff } from '../auth.js';
import { nowIso } from '../db.js';
import { HttpError, ROLE_LABELS, bool, generatePassword, optText, reqText, validatePassword } from '../util.js';

const EMPLOYEE_ROLES = ['director', 'secretary', 'teacher'];
const FIELDS = `id, role, username, full_name, email, phone, employee_number, position, active,
  must_change_password, last_login_at, created_at, updated_at`;

function withLabel(e) {
  return e && { ...e, role_label: ROLE_LABELS[e.role] };
}

export default function employeeRoutes({ db }) {
  const router = Router();

  const getOne = db.prepare(`SELECT ${FIELDS} FROM users WHERE id = ? AND school_id = ? AND role != 'admin'`);
  const usernameTaken = db.prepare('SELECT id FROM users WHERE school_id = ? AND username = ? AND id != ?');

  function parseUsername(value, schoolId, selfId = 0) {
    const username = reqText(value, 100, 'El usuario').toLowerCase();
    if (/\s/.test(username)) throw new HttpError(400, 'El usuario no puede tener espacios.');
    if (username === 'admin') throw new HttpError(400, 'El usuario "admin" está reservado.');
    if (usernameTaken.get(schoolId, username, selfId)) throw new HttpError(409, 'Ese usuario ya existe en esta escuela.');
    return username;
  }

  function parseRole(value) {
    const role = String(value || 'teacher');
    if (!EMPLOYEE_ROLES.includes(role)) throw new HttpError(400, 'Rol no válido.');
    return role;
  }

  router.get('/', requireStaff(), (req, res) => {
    const includeInactive = bool(req.query.include_inactive);
    const rows = db
      .prepare(
        `SELECT ${FIELDS},
           (SELECT COUNT(*) FROM absences a WHERE a.user_id = users.id AND a.status != 'cancelled') AS absence_count
         FROM users WHERE school_id = ? AND role != 'admin' ${includeInactive ? '' : 'AND active = 1'}
         ORDER BY active DESC, full_name COLLATE NOCASE`,
      )
      .all(req.user.school_id);
    res.json({ employees: rows.map(withLabel) });
  });

  router.get('/:id', requireManager(), (req, res) => {
    const employee = getOne.get(Number(req.params.id), req.user.school_id);
    if (!employee) throw new HttpError(404, 'Empleado no encontrado.');
    res.json({ employee: withLabel(employee) });
  });

  router.post('/', requireManager(), async (req, res) => {
    const b = req.body || {};
    const sid = req.user.school_id;
    const fullName = reqText(b.full_name, 120, 'El nombre');
    const email = optText(b.email, 200, 'El correo');
    const username = parseUsername(b.username || email, sid);
    const role = parseRole(b.role);
    const tempPassword = b.password ? String(b.password) : generatePassword();
    validatePassword(tempPassword);

    const info = db
      .prepare(
        `INSERT INTO users (school_id, role, username, full_name, email, phone, employee_number, position,
                            password_hash, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        sid,
        role,
        username,
        fullName,
        email,
        optText(b.phone, 40, 'El teléfono'),
        optText(b.employee_number, 40, 'El número de empleado'),
        optText(b.position, 120, 'El puesto'),
        await hashPassword(tempPassword),
      );
    res.status(201).json({ employee: withLabel(getOne.get(info.lastInsertRowid, sid)), temp_password: tempPassword });
  });

  router.patch('/:id', requireManager(), (req, res) => {
    const sid = req.user.school_id;
    const employee = getOne.get(Number(req.params.id), sid);
    if (!employee) throw new HttpError(404, 'Empleado no encontrado.');
    const b = req.body || {};
    const isSelf = employee.id === req.user.id;

    const next = {
      full_name: 'full_name' in b ? reqText(b.full_name, 120, 'El nombre') : employee.full_name,
      username: 'username' in b ? parseUsername(b.username, sid, employee.id) : employee.username,
      email: 'email' in b ? optText(b.email, 200, 'El correo') : employee.email,
      phone: 'phone' in b ? optText(b.phone, 40, 'El teléfono') : employee.phone,
      employee_number: 'employee_number' in b ? optText(b.employee_number, 40, 'El número de empleado') : employee.employee_number,
      position: 'position' in b ? optText(b.position, 120, 'El puesto') : employee.position,
      role: 'role' in b ? parseRole(b.role) : employee.role,
      active: 'active' in b ? (bool(b.active) ? 1 : 0) : employee.active,
    };
    if (isSelf && (next.role !== employee.role || !next.active)) {
      throw new HttpError(400, 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta.');
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE users SET full_name = ?, username = ?, email = ?, phone = ?, employee_number = ?, position = ?,
                          role = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.full_name,
        next.username,
        next.email,
        next.phone,
        next.employee_number,
        next.position,
        next.role,
        next.active,
        nowIso(),
        employee.id,
      );
      // Role or status changes take effect immediately: sign the employee out everywhere.
      if (!next.active || next.role !== employee.role) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(employee.id);
      }
      if (!next.active) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(employee.id);
    })();
    res.json({ employee: withLabel(getOne.get(employee.id, sid)) });
  });

  router.post('/:id/reset-password', requireManager(), async (req, res) => {
    const employee = getOne.get(Number(req.params.id), req.user.school_id);
    if (!employee) throw new HttpError(404, 'Empleado no encontrado.');
    const tempPassword = req.body?.password ? String(req.body.password) : generatePassword();
    validatePassword(tempPassword);
    const hash = await hashPassword(tempPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(
        hash,
        nowIso(),
        employee.id,
      );
      if (employee.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(employee.id);
    })();
    res.json({ temp_password: tempPassword });
  });

  router.delete('/:id', requireManager(), (req, res) => {
    const employee = getOne.get(Number(req.params.id), req.user.school_id);
    if (!employee) throw new HttpError(404, 'Empleado no encontrado.');
    if (employee.id === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propia cuenta.');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM absences WHERE user_id = ?').get(employee.id);
    if (n > 0) {
      throw new HttpError(409, 'Este empleado tiene ausencias registradas. Desactívalo en lugar de eliminarlo para conservar el historial.');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(employee.id);
    res.json({ ok: true });
  });

  return router;
}

import { Router } from 'express';
import { requireManager } from '../auth.js';
import { ABSENCE_SELECT } from './absences.js';
import {
  CATEGORIES,
  ROLE_LABELS,
  STATUS_LABELS,
  addDays,
  isDate,
  todayLocal,
  toCsv,
  weekdaysBetween,
} from '../util.js';

function absenceDays(a, from, to) {
  if (a.partial) return 0.5;
  const s = from && a.start_date < from ? from : a.start_date;
  const e = to && a.end_date > to ? to : a.end_date;
  return e < s ? 0 : weekdaysBetween(s, e);
}

export default function dataRoutes({ db }) {
  const router = Router();
  router.use(requireManager());

  function range(query, defaultDays) {
    const to = isDate(query.to) ? query.to : null;
    const from = isDate(query.from) ? query.from : null;
    if (!from && !to && defaultDays) return { from: addDays(todayLocal(), -defaultDays), to: todayLocal() };
    return { from, to };
  }

  function absencesIn(schoolId, { from, to }, includeCancelled = false) {
    const where = ['a.school_id = ?'];
    const params = [schoolId];
    if (!includeCancelled) where.push("a.status != 'cancelled'");
    if (from) {
      where.push('a.end_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('a.start_date <= ?');
      params.push(to);
    }
    return db.prepare(`${ABSENCE_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_date DESC, a.id DESC`).all(...params);
  }

  router.get('/stats', (req, res) => {
    const r = range(req.query, 30);
    const rows = absencesIn(req.user.school_id, r);
    const byEmployee = new Map();
    const byCategory = new Map();
    let totalDays = 0;
    for (const a of rows) {
      const days = absenceDays(a, r.from, r.to);
      totalDays += days;
      const e = byEmployee.get(a.user_id) || {
        user_id: a.user_id,
        full_name: a.employee_name,
        position: a.employee_position,
        count: 0,
        days: 0,
      };
      e.count++;
      e.days += days;
      byEmployee.set(a.user_id, e);
      const key = a.category || 'sin_especificar';
      byCategory.set(key, (byCategory.get(key) || 0) + 1);
    }
    res.json({
      from: r.from,
      to: r.to,
      totals: {
        absences: rows.length,
        days: totalDays,
        employees: byEmployee.size,
        pending: rows.filter((a) => a.status === 'pending').length,
        uncovered: rows.filter((a) => !a.substitute).length,
      },
      by_employee: [...byEmployee.values()].sort((a, b) => b.days - a.days || b.count - a.count),
      by_category: [...byCategory.entries()]
        .map(([category, count]) => ({ category, label: CATEGORIES[category] || 'Sin especificar', count }))
        .sort((a, b) => b.count - a.count),
    });
  });

  router.get('/export/absences.csv', (req, res) => {
    const r = range(req.query, 0);
    const rows = absencesIn(req.user.school_id, r, true);
    const csv = toCsv([
      [
        'ID', 'Empleado', 'Puesto', 'Desde', 'Hasta', 'Días laborables', 'Parcial', 'Hora inicio', 'Hora fin',
        'Tipo', 'Causa', 'Notas para cubrir', 'Estado', 'Recibida por', 'Fecha recibida', 'Cubierto por',
        'Documentos', 'Comentarios', 'Registrada por', 'Creada',
      ],
      ...rows.map((a) => [
        a.id, a.employee_name, a.employee_position, a.start_date, a.end_date, absenceDays(a), a.partial ? 'Sí' : 'No',
        a.start_time, a.end_time, CATEGORIES[a.category] || '', a.reason, a.coverage_notes, STATUS_LABELS[a.status],
        a.received_by_name, a.received_at, a.substitute, a.attachment_count, a.comment_count, a.created_by_name,
        a.created_at,
      ]),
    ]);
    const suffix = r.from || r.to ? `_${r.from || 'inicio'}_${r.to || 'hoy'}` : '';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ausencias_${req.school.code}${suffix}.csv"`);
    res.send(csv);
  });

  router.get('/export/employees.csv', (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM absences a WHERE a.user_id = u.id AND a.status != 'cancelled') AS absence_count
         FROM users u WHERE u.school_id = ? AND u.role != 'admin' ORDER BY u.full_name COLLATE NOCASE`,
      )
      .all(req.user.school_id);
    const csv = toCsv([
      ['ID', 'Nombre', 'Usuario', 'Rol', 'Puesto', 'Correo', 'Teléfono', 'Núm. empleado', 'Activo', 'Ausencias', 'Último acceso', 'Creado'],
      ...rows.map((u) => [
        u.id, u.full_name, u.username, ROLE_LABELS[u.role], u.position, u.email, u.phone, u.employee_number,
        u.active ? 'Sí' : 'No', u.absence_count, u.last_login_at, u.created_at,
      ]),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="empleados_${req.school.code}.csv"`);
    res.send(csv);
  });

  // Full copy of this school's data (no password hashes) for backups or migrations.
  router.get('/export/backup.json', (req, res) => {
    const sid = req.user.school_id;
    const school = db.prepare('SELECT id, code, name, teams_enabled, teams_include_reason, created_at FROM schools WHERE id = ?').get(sid);
    const backup = {
      generated_at: new Date().toISOString(),
      school,
      employees: db
        .prepare(
          `SELECT id, role, username, full_name, email, phone, employee_number, position, active, last_login_at, created_at
           FROM users WHERE school_id = ?`,
        )
        .all(sid),
      absences: db.prepare('SELECT * FROM absences WHERE school_id = ?').all(sid),
      comments: db
        .prepare('SELECT c.* FROM comments c JOIN absences a ON a.id = c.absence_id WHERE a.school_id = ?')
        .all(sid),
      attachments: db
        .prepare('SELECT id, absence_id, uploaded_by, original_name, mime, size, created_at FROM attachments WHERE school_id = ?')
        .all(sid),
    };
    res.setHeader('Content-Disposition', `attachment; filename="respaldo_${school.code}_${todayLocal()}.json"`);
    res.json(backup);
  });

  return router;
}

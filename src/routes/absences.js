import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireUser, requireStaff } from '../auth.js';
import { nowIso } from '../db.js';
import { INLINE_MIME, createUpload, removeFiles, uploadDir } from '../uploads.js';
import {
  CATEGORIES,
  HttpError,
  addDays,
  bool,
  clientToday,
  daysBetween,
  isDate,
  isManager,
  isStaff,
  isTime,
  optText,
  reqText,
} from '../util.js';

export const ABSENCE_SELECT = `
  SELECT a.*, u.full_name AS employee_name, u.position AS employee_position, u.role AS employee_role,
         r.full_name AS received_by_name, cb.full_name AS created_by_name,
         (SELECT COUNT(*) FROM attachments t WHERE t.absence_id = a.id) AS attachment_count,
         (SELECT COUNT(*) FROM comments m WHERE m.absence_id = a.id) AS comment_count
  FROM absences a
  JOIN users u ON u.id = a.user_id
  LEFT JOIN users r ON r.id = a.received_by
  LEFT JOIN users cb ON cb.id = a.created_by
`;

export default function absenceRoutes({ db, config, notifier }) {
  const router = Router();
  const upload = createUpload(config);

  const getAbsence = db.prepare(`${ABSENCE_SELECT} WHERE a.id = ? AND a.school_id = ?`);
  const getAttachments = db.prepare(
    `SELECT t.id, t.original_name, t.mime, t.size, t.created_at, t.uploaded_by, u.full_name AS uploaded_by_name
     FROM attachments t LEFT JOIN users u ON u.id = t.uploaded_by
     WHERE t.absence_id = ? ORDER BY t.id`,
  );
  const getComments = db.prepare(
    'SELECT id, user_id, author_name, author_role, body, created_at FROM comments WHERE absence_id = ? ORDER BY id',
  );
  const insertAttachment = db.prepare(
    `INSERT INTO attachments (absence_id, school_id, uploaded_by, original_name, stored_name, mime, size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertComment = db.prepare(
    'INSERT INTO comments (absence_id, user_id, author_name, author_role, body) VALUES (?, ?, ?, ?, ?)',
  );
  const findEmployee = db.prepare(
    "SELECT id, full_name, position, role FROM users WHERE id = ? AND school_id = ? AND active = 1 AND role != 'admin'",
  );

  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

  function loadAbsence(req, id) {
    const absence = getAbsence.get(Number(id), req.user.school_id);
    if (!absence || (!isStaff(req.user) && absence.user_id !== req.user.id)) {
      throw new HttpError(404, 'No se encontró la ausencia.');
    }
    return absence;
  }

  function saveAttachments(absenceId, schoolId, userId, files) {
    for (const f of files || []) {
      insertAttachment.run(absenceId, schoolId, userId, f.originalname.slice(0, 200), f.filename, f.detectedMime, f.size);
    }
  }

  /** Runs a multipart handler and deletes uploaded files if anything fails afterwards. */
  function withUpload(handler) {
    return [
      upload.array('files', 5),
      async (req, res) => {
        try {
          await handler(req, res);
        } catch (err) {
          removeFiles(req.files);
          throw err;
        }
      },
    ];
  }

  // ---- Listing ----------------------------------------------------------

  router.get('/absences', requireUser(), (req, res) => {
    const scope = req.query.scope === 'school' ? 'school' : 'mine';
    if (scope === 'mine') {
      const rows = db
        .prepare(`${ABSENCE_SELECT} WHERE a.school_id = ? AND a.user_id = ? ORDER BY a.start_date DESC, a.id DESC LIMIT 300`)
        .all(req.user.school_id, req.user.id);
      return res.json({ absences: rows });
    }

    if (!isStaff(req.user)) throw new HttpError(403, 'No tienes permiso para ver todas las ausencias.');
    const where = ['a.school_id = ?'];
    const params = [req.user.school_id];
    const { from, to, status, q, user_id: userId } = req.query;
    if (isDate(from)) {
      where.push('a.end_date >= ?');
      params.push(from);
    }
    if (isDate(to)) {
      where.push('a.start_date <= ?');
      params.push(to);
    }
    if (status === 'active') where.push("a.status != 'cancelled'");
    else if (['pending', 'received', 'cancelled'].includes(status)) {
      where.push('a.status = ?');
      params.push(status);
    }
    if (q && String(q).trim()) {
      where.push('u.full_name LIKE ?');
      params.push(`%${String(q).trim().slice(0, 100)}%`);
    }
    if (userId && Number(userId)) {
      where.push('a.user_id = ?');
      params.push(Number(userId));
    }
    const rows = db
      .prepare(`${ABSENCE_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_date DESC, a.id DESC LIMIT 500`)
      .all(...params);
    res.json({ absences: rows });
  });

  router.get('/dashboard', requireStaff(), (req, res) => {
    const today = clientToday(req.query.today);
    const horizon = addDays(today, 14);
    const sid = req.user.school_id;
    const todayList = db
      .prepare(
        `${ABSENCE_SELECT} WHERE a.school_id = ? AND a.status != 'cancelled' AND a.start_date <= ? AND a.end_date >= ?
         ORDER BY a.partial, u.full_name`,
      )
      .all(sid, today, today);
    const upcoming = db
      .prepare(
        `${ABSENCE_SELECT} WHERE a.school_id = ? AND a.status != 'cancelled' AND a.start_date > ? AND a.start_date <= ?
         ORDER BY a.start_date, u.full_name`,
      )
      .all(sid, today, horizon);
    const pending = db
      .prepare(`${ABSENCE_SELECT} WHERE a.school_id = ? AND a.status = 'pending' ORDER BY a.created_at DESC LIMIT 50`)
      .all(sid);
    res.json({
      today,
      today_list: todayList,
      upcoming,
      pending,
      counts: {
        today: todayList.length,
        uncovered_today: todayList.filter((a) => !a.substitute).length,
        pending: pending.length,
        upcoming: upcoming.length,
      },
    });
  });

  router.get('/absences/:id', requireUser(), (req, res) => {
    const absence = loadAbsence(req, req.params.id);
    res.json({
      absence,
      attachments: getAttachments.all(absence.id),
      comments: getComments.all(absence.id),
    });
  });

  // ---- Create -----------------------------------------------------------

  router.post(
    '/absences',
    requireUser(),
    ...withUpload(async (req, res) => {
      const b = req.body || {};
      const me = req.user;

      let employee;
      if (b.user_id && Number(b.user_id) !== me.id) {
        if (!isStaff(me)) throw new HttpError(403, 'Solo dirección o secretaría pueden registrar ausencias de otros.');
        employee = findEmployee.get(Number(b.user_id), me.school_id);
        if (!employee) throw new HttpError(400, 'El empleado seleccionado no existe o está inactivo.');
      } else {
        if (me.role === 'admin') throw new HttpError(400, 'Selecciona el empleado que va a faltar.');
        employee = { id: me.id, full_name: me.full_name, position: me.position, role: me.role };
      }

      const start = b.start_date;
      const partial = bool(b.partial);
      const end = partial ? start : b.end_date || start;
      if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'Selecciona una fecha válida.');
      if (end < start) throw new HttpError(400, 'La fecha final no puede ser antes de la fecha inicial.');
      if (daysBetween(start, end) > 90) throw new HttpError(400, 'Una ausencia no puede durar más de 90 días.');
      const today = clientToday(b.today);
      if (daysBetween(start, today) > 60) throw new HttpError(400, 'La fecha es demasiado antigua (máx. 60 días atrás).');
      if (daysBetween(today, start) > 365) throw new HttpError(400, 'La fecha es demasiado lejana.');

      let startTime = null;
      let endTime = null;
      if (partial) {
        if (!isTime(b.start_time)) throw new HttpError(400, 'Indica la hora de inicio de la ausencia.');
        startTime = b.start_time;
        if (b.end_time) {
          if (!isTime(b.end_time) || b.end_time <= startTime) {
            throw new HttpError(400, 'La hora final debe ser después de la hora de inicio.');
          }
          endTime = b.end_time;
        }
      }

      const category = b.category ? String(b.category) : null;
      if (category && !CATEGORIES[category]) throw new HttpError(400, 'Tipo de ausencia no válido.');
      const reason = optText(b.reason, 1000, 'La causa');
      const coverageNotes = optText(b.coverage_notes, 1000, 'Las notas para cubrir');

      const id = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO absences (school_id, user_id, created_by, start_date, end_date, partial, start_time, end_time,
                                   category, reason, coverage_notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(me.school_id, employee.id, me.id, start, end, partial ? 1 : 0, startTime, endTime, category, reason, coverageNotes);
        saveAttachments(info.lastInsertRowid, me.school_id, me.id, req.files);
        return Number(info.lastInsertRowid);
      })();

      const absence = getAbsence.get(id, me.school_id);
      notifier.absenceCreated(absence, {
        employee,
        createdBy: me,
        baseUrl: baseUrl(req),
        attachmentCount: req.files?.length || 0,
      });
      res.status(201).json({ absence });
    }),
  );

  // ---- Updates ----------------------------------------------------------

  router.post(
    '/absences/:id/attachments',
    requireUser(),
    ...withUpload(async (req, res) => {
      const absence = loadAbsence(req, req.params.id);
      if (absence.status === 'cancelled') throw new HttpError(400, 'La ausencia está cancelada.');
      if (!req.files?.length) throw new HttpError(400, 'Selecciona al menos un archivo.');
      const existing = getAttachments.all(absence.id).length;
      if (existing + req.files.length > 10) throw new HttpError(400, 'Máximo 10 documentos por ausencia.');
      db.transaction(() => saveAttachments(absence.id, req.user.school_id, req.user.id, req.files))();
      db.prepare('UPDATE absences SET updated_at = ? WHERE id = ?').run(nowIso(), absence.id);
      notifier.attachmentAdded(absence, { actor: req.user, count: req.files.length });
      res.status(201).json({ attachments: getAttachments.all(absence.id) });
    }),
  );

  router.post('/absences/:id/receive', requireStaff(), (req, res) => {
    const absence = loadAbsence(req, req.params.id);
    if (absence.status === 'cancelled') throw new HttpError(400, 'La ausencia está cancelada.');
    const comment = optText(req.body?.comment, 2000, 'El comentario');
    db.transaction(() => {
      if (absence.status === 'pending') {
        db.prepare("UPDATE absences SET status = 'received', received_by = ?, received_at = ?, updated_at = ? WHERE id = ?").run(
          req.user.id,
          nowIso(),
          nowIso(),
          absence.id,
        );
      }
      if (comment) insertComment.run(absence.id, req.user.id, req.user.full_name, req.user.role, comment);
    })();
    if (absence.status === 'pending') notifier.absenceReceived(absence, { actor: req.user, comment });
    else if (comment) notifier.commentAdded(absence, { actor: req.user, body: comment });
    res.json({ absence: getAbsence.get(absence.id, req.user.school_id) });
  });

  router.patch('/absences/:id', requireStaff(), (req, res) => {
    const absence = loadAbsence(req, req.params.id);
    if (!('substitute' in (req.body || {}))) throw new HttpError(400, 'Nada que actualizar.');
    const substitute = optText(req.body.substitute, 300, 'La cobertura');
    db.prepare('UPDATE absences SET substitute = ?, updated_at = ? WHERE id = ?').run(substitute, nowIso(), absence.id);
    const updated = getAbsence.get(absence.id, req.user.school_id);
    if (substitute && substitute !== absence.substitute) notifier.coverageUpdated(updated, { actor: req.user });
    res.json({ absence: updated });
  });

  router.post('/absences/:id/comments', requireUser(), (req, res) => {
    const absence = loadAbsence(req, req.params.id);
    const body = reqText(req.body?.body, 2000, 'El comentario');
    const info = insertComment.run(absence.id, req.user.id, req.user.full_name, req.user.role, body);
    db.prepare('UPDATE absences SET updated_at = ? WHERE id = ?').run(nowIso(), absence.id);
    notifier.commentAdded(absence, { actor: req.user, body });
    res.status(201).json({
      comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid),
    });
  });

  router.post('/absences/:id/cancel', requireUser(), (req, res) => {
    const absence = loadAbsence(req, req.params.id);
    if (absence.user_id !== req.user.id && !isStaff(req.user)) {
      throw new HttpError(403, 'No puedes cancelar esta ausencia.');
    }
    if (absence.status === 'cancelled') throw new HttpError(400, 'La ausencia ya estaba cancelada.');
    db.prepare("UPDATE absences SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      absence.id,
    );
    const updated = getAbsence.get(absence.id, req.user.school_id);
    const employee = { id: absence.user_id, full_name: absence.employee_name };
    notifier.absenceCancelled(updated, { employee, actor: req.user, baseUrl: baseUrl(req) });
    res.json({ absence: updated });
  });

  // ---- Attachments ------------------------------------------------------

  const getAttachment = db.prepare(
    `SELECT t.*, a.user_id AS owner_id FROM attachments t JOIN absences a ON a.id = t.absence_id
     WHERE t.id = ? AND t.school_id = ?`,
  );

  function loadAttachment(req) {
    const att = getAttachment.get(Number(req.params.id), req.user.school_id);
    if (!att || (!isStaff(req.user) && att.owner_id !== req.user.id)) {
      throw new HttpError(404, 'No se encontró el archivo.');
    }
    return att;
  }

  router.get('/attachments/:id', requireUser(), (req, res) => {
    const att = loadAttachment(req);
    const file = path.join(uploadDir(config, att.school_id), path.basename(att.stored_name));
    if (!fs.existsSync(file)) throw new HttpError(404, 'El archivo ya no está disponible.');
    const disposition = INLINE_MIME.has(att.mime) && req.query.download !== '1' ? 'inline' : 'attachment';
    const asciiName = att.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', att.mime);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(att.original_name)}`,
    );
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  });

  router.delete('/attachments/:id', requireUser(), (req, res) => {
    const att = loadAttachment(req);
    if (att.uploaded_by !== req.user.id && !isManager(req.user)) {
      throw new HttpError(403, 'Solo quien subió el archivo puede eliminarlo.');
    }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
    fs.rm(path.join(uploadDir(config, att.school_id), path.basename(att.stored_name)), { force: true }, () => {});
    res.json({ ok: true });
  });

  return router;
}

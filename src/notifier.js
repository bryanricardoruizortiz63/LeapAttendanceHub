import { buildCard, postToTeams } from './teams.js';
import { CATEGORIES, formatRangeEs } from './util.js';
import { nowIso } from './db.js';

export function createNotifier({ db, config, push }) {
  const insert = db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)');
  const staffOf = db.prepare(
    "SELECT id FROM users WHERE school_id = ? AND active = 1 AND role IN ('admin','director','secretary')",
  );
  const schoolById = db.prepare('SELECT * FROM schools WHERE id = ?');
  const setTeamsStatus = db.prepare('UPDATE schools SET teams_last_status = ?, teams_last_at = ? WHERE id = ?');

  function notifyUsers(userIds, { title, body = null, link = null }) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    db.transaction(() => {
      for (const id of ids) insert.run(id, title, body, link);
    })();
    push
      .sendToUsers(ids, { title, body, url: link ? `/${link}` : '/' })
      .catch((err) => console.warn('[push]', err.message));
  }

  function notifyStaff(schoolId, excludeUserId, payload) {
    const ids = staffOf.all(schoolId).map((r) => r.id).filter((id) => id !== excludeUserId);
    notifyUsers(ids, payload);
  }

  async function sendTeams(schoolId, card) {
    const school = schoolById.get(schoolId);
    if (!school?.teams_webhook_url || !school.teams_enabled) return { skipped: true };
    try {
      await postToTeams(school.teams_webhook_url, card);
      setTeamsStatus.run('ok', nowIso(), schoolId);
      return { ok: true };
    } catch (err) {
      console.warn(`[teams] escuela ${school.code}:`, err.message);
      setTeamsStatus.run(`error: ${err.message}`.slice(0, 300), nowIso(), schoolId);
      return { ok: false, error: err.message };
    }
  }

  function absenceLink(absenceId) {
    return `#/absence/${absenceId}`;
  }

  function absoluteLink(baseUrl, absenceId) {
    const base = config.publicUrl || baseUrl;
    return `${base}/${absenceLink(absenceId)}`;
  }

  function timeText(a) {
    return a.partial && a.start_time ? `${a.start_time} – ${a.end_time || ''}`.trim() : 'Día completo';
  }

  return {
    notifyUsers,
    sendTeams,

    absenceCreated(absence, { employee, createdBy, baseUrl, attachmentCount }) {
      const range = formatRangeEs(absence.start_date, absence.end_date);
      const onBehalf = createdBy && createdBy.id !== employee.id;
      notifyStaff(absence.school_id, createdBy?.id, {
        title: `Nueva ausencia: ${employee.full_name}`,
        body: `${range} · ${timeText(absence)}${absence.category ? ` · ${CATEGORIES[absence.category] || ''}` : ''}`,
        link: absenceLink(absence.id),
      });
      if (onBehalf) {
        notifyUsers([employee.id], {
          title: 'Se registró una ausencia a tu nombre',
          body: `${createdBy.full_name} registró tu ausencia para ${range}.`,
          link: absenceLink(absence.id),
        });
      }

      const school = schoolById.get(absence.school_id);
      const card = buildCard({
        title: '🗓️ Nueva ausencia reportada',
        subtitle: school?.name,
        facts: [
          { title: 'Empleado', value: employee.full_name },
          { title: 'Puesto', value: employee.position },
          { title: 'Fecha', value: range },
          { title: 'Horario', value: timeText(absence) },
          { title: 'Tipo', value: CATEGORIES[absence.category] },
          { title: 'Causa', value: school?.teams_include_reason ? absence.reason : null },
          { title: 'Notas para cubrir', value: absence.coverage_notes },
          { title: 'Documentos', value: attachmentCount ? `${attachmentCount} adjunto(s)` : null },
          { title: 'Registrada por', value: onBehalf ? createdBy.full_name : null },
        ],
        linkUrl: absoluteLink(baseUrl, absence.id),
      });
      sendTeams(absence.school_id, card);
    },

    absenceCancelled(absence, { employee, actor, baseUrl }) {
      const range = formatRangeEs(absence.start_date, absence.end_date);
      notifyStaff(absence.school_id, actor.id, {
        title: `Ausencia cancelada: ${employee.full_name}`,
        body: range,
        link: absenceLink(absence.id),
      });
      if (actor.id !== employee.id) {
        notifyUsers([employee.id], { title: 'Tu ausencia fue cancelada', body: range, link: absenceLink(absence.id) });
      }
      sendTeams(
        absence.school_id,
        buildCard({
          title: '↩️ Ausencia cancelada',
          subtitle: schoolById.get(absence.school_id)?.name,
          facts: [
            { title: 'Empleado', value: employee.full_name },
            { title: 'Fecha', value: range },
          ],
          linkUrl: absoluteLink(baseUrl, absence.id),
        }),
      );
    },

    absenceReceived(absence, { actor, comment }) {
      notifyUsers([absence.user_id], {
        title: 'Tu ausencia fue recibida ✅',
        body: comment ? `${actor.full_name}: ${comment}` : `Confirmada por ${actor.full_name}.`,
        link: absenceLink(absence.id),
      });
    },

    coverageUpdated(absence, { actor }) {
      if (!absence.substitute) return;
      notifyUsers([absence.user_id], {
        title: 'Se asignó cobertura para tu ausencia',
        body: `${absence.substitute} (por ${actor.full_name})`,
        link: absenceLink(absence.id),
      });
    },

    commentAdded(absence, { actor, body }) {
      const payload = {
        title: `Nuevo comentario de ${actor.full_name}`,
        body: body.length > 140 ? `${body.slice(0, 137)}…` : body,
        link: absenceLink(absence.id),
      };
      if (actor.id === absence.user_id) notifyStaff(absence.school_id, actor.id, payload);
      else notifyUsers([absence.user_id], payload);
    },

    attachmentAdded(absence, { actor, count }) {
      const payload = {
        title: `Nuevo documento en una ausencia`,
        body: `${actor.full_name} subió ${count} archivo(s).`,
        link: absenceLink(absence.id),
      };
      if (actor.id === absence.user_id) notifyStaff(absence.school_id, actor.id, payload);
      else notifyUsers([absence.user_id], payload);
    },
  };
}

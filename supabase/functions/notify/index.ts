// Processes one outbox row: a push notification to a user's devices or a Teams card for the school.
// Called by the database (pg_net) right after the row is inserted. Each row is processed only once,
// so calling it again is harmless.
import { json, serve, serviceClient } from '../_shared/http.ts';
import { buildCard, CATEGORIES, fmtRangeEs, postToTeams, scheduleText } from '../_shared/teams.ts';
import { sendWebPush, type VapidKeys } from '../_shared/webpush.ts';

const db = serviceClient();

async function setting<T>(key: string): Promise<T | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? null;
}

async function handlePush(payload: { notification_id: number }): Promise<string> {
  const { data: n } = await db
    .from('notifications')
    .select('id, user_id, title, body, link')
    .eq('id', payload.notification_id)
    .maybeSingle();
  if (!n) return 'push: notification not found';
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', n.user_id);
  if (!subs?.length) return 'push: no subscriptions';
  const vapid = await setting<VapidKeys>('vapid');
  if (!vapid) return 'push: VAPID keys missing';

  const message = JSON.stringify({ title: n.title, body: n.body || '', url: n.link || '#/notifications' });
  const results = await Promise.all(
    subs.map(async (s) => {
      try {
        const res = await sendWebPush(s, message, vapid);
        if (res.status === 404 || res.status === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
        return String(res.status);
      } catch (err) {
        return `err ${(err as Error).message}`;
      }
    }),
  );
  return `push: ${results.join(', ')}`;
}

async function handleTeams(schoolId: string, payload: { event: string; absence_id: number }): Promise<string> {
  const { data: settings } = await db.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle();
  if (!settings?.teams_webhook_url || !settings.teams_enabled) return 'teams: skipped';
  const { data: a } = await db.from('absences_v').select('*').eq('id', payload.absence_id).maybeSingle();
  if (!a) return 'teams: absence not found';
  const { data: school } = await db.from('schools').select('name').eq('id', schoolId).single();
  const app = await setting<{ url: string }>('app_url');
  const linkUrl = app?.url ? `${app.url.replace(/\/?$/, '/')}#/absence/${a.id}` : null;
  const range = fmtRangeEs(a.start_date, a.end_date);
  const onBehalf = a.created_by && a.created_by !== a.user_id;

  const card =
    payload.event === 'cancelled'
      ? buildCard({
          title: '↩️ Ausencia cancelada',
          subtitle: school?.name,
          facts: [
            { title: 'Empleado', value: a.employee_name },
            { title: 'Fecha', value: range },
          ],
          linkUrl,
        })
      : buildCard({
          title: '🗓️ Nueva ausencia reportada',
          subtitle: school?.name,
          facts: [
            { title: 'Empleado', value: a.employee_name },
            { title: 'Puesto', value: a.employee_position },
            { title: 'Fecha', value: range },
            { title: 'Horario', value: scheduleText(a) },
            { title: 'Tipo', value: a.category ? CATEGORIES[a.category] : null },
            { title: 'Causa', value: settings.teams_include_reason ? a.reason : null },
            { title: 'Notas para cubrir', value: a.coverage_notes },
            { title: 'Documentos', value: a.attachment_count ? `${a.attachment_count} adjunto(s)` : null },
            { title: 'Registrada por', value: onBehalf ? a.created_by_name : null },
          ],
          linkUrl,
        });

  let status = 'ok';
  try {
    await postToTeams(settings.teams_webhook_url, card);
  } catch (err) {
    status = `error: ${(err as Error).message}`.slice(0, 300);
  }
  await db
    .from('school_settings')
    .update({ teams_last_status: status, teams_last_at: new Date().toISOString() })
    .eq('school_id', schoolId);
  return `teams: ${status}`;
}

serve(async (req) => {
  let id: unknown;
  try {
    ({ id } = await req.json());
  } catch {
    return json({ error: 'Solicitud no válida.' }, 400);
  }
  if (!Number.isInteger(id)) return json({ error: 'Solicitud no válida.' }, 400);

  // Claim the row atomically so each event is delivered at most once.
  const { data: job } = await db
    .from('outbox')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', id)
    .is('processed_at', null)
    .select()
    .maybeSingle();
  if (!job) return json({ skipped: true });

  let result: string;
  try {
    result = job.kind === 'push' ? await handlePush(job.payload) : await handleTeams(job.school_id, job.payload);
  } catch (err) {
    result = `error: ${(err as Error).message}`;
  }
  await db.from('outbox').update({ result: result.slice(0, 500) }).eq('id', id);
  return json({ ok: true, result });
});

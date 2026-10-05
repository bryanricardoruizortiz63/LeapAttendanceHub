// All data access for the app: Supabase Auth, database (RLS + RPC functions), Storage and Edge Functions.
import { MAX_UPLOAD_MB, SUPABASE_KEY, SUPABASE_URL } from './config.js';
import { CATEGORIES, ROLE_LABELS, STATUS, addDays, todayStr, weekdays } from './lib.js';
import { buildXlsx, xDate, xDateTime } from './xlsx.js';
import { zip } from './zip.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'lah-auth' },
});

const BUCKET = 'excuses';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function unauthorized() {
  window.dispatchEvent(new CustomEvent('lah:unauthorized'));
  return new ApiError('Tu sesión expiró. Vuelve a iniciar sesión.', 401);
}

/** Turns Supabase errors into short Spanish messages. Messages raised by our SQL functions are already Spanish. */
function toApiError(error) {
  if (!error) return new ApiError('Ocurrió un error. Inténtalo de nuevo.');
  const msg = String(error.message || '');
  if (error.hint === 'unauthorized' || /JWT|jwt expired|invalid claim|not authenticated/i.test(msg)) return unauthorized();
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return new ApiError('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  if (/permission denied|violates row-level security/i.test(msg)) {
    return new ApiError('No tienes permiso para realizar esta acción.', 403);
  }
  if (error.code === 'P0001' || /[áéíóúñ¿¡]/i.test(msg)) return new ApiError(msg, 400);
  console.warn(error);
  return new ApiError('Ocurrió un error. Inténtalo de nuevo.');
}

async function run(query) {
  const { data, error, count } = await query;
  if (error) throw toApiError(error);
  return count !== undefined && count !== null && data === null ? count : data;
}

const rpc = (name, args) => run(sb.rpc(name, args));

/** Reads every row of a query in pages (the API returns at most 1000 at a time). Keep the query ordered. */
async function fetchAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await run(makeQuery().range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/** Runs `.in(column, ids)` in chunks so the request URL stays short. */
async function fetchByIds(table, column, ids, select = '*') {
  const rows = [];
  for (let i = 0; i < ids.length; i += 150) {
    rows.push(...(await run(sb.from(table).select(select).in(column, ids.slice(i, i + 150)).order('id'))));
  }
  return rows;
}

async function callFunction(name, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (auth) {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw unauthorized();
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && auth) throw unauthorized();
    throw new ApiError(data?.error || 'Ocurrió un error. Inténtalo de nuevo.', res.status);
  }
  return data;
}

// ---- Sesión ----------------------------------------------------------------

/** Internal login email for "school code + username" (the Edge Functions compute the same value). */
export async function authEmail(code, username) {
  const bytes = new TextEncoder().encode(`${code.trim().toUpperCase()}|${username.trim().toLowerCase()}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  return `u${hex}@users.leap-hub.local`;
}

export async function getMe() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  try {
    return await rpc('me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

export async function signIn(schoolCode, username, password) {
  let code = String(schoolCode || '').trim().toUpperCase();
  const user = String(username || '').trim();
  if (!code || !user || !password) throw new ApiError('Completa todos los campos.');
  let { error } = await sb.auth.signInWithPassword({ email: await authEmail(code, user), password });
  if (error?.status === 400) {
    // The school may have changed its code: an old code (or an old link) still works.
    const current = await rpc('current_school_code', { p_code: code }).catch(() => null);
    if (current && current !== code) {
      code = current;
      ({ error } = await sb.auth.signInWithPassword({ email: await authEmail(code, user), password }));
    }
  }
  if (error) {
    if (error.code === 'user_banned') throw new ApiError('Tu cuenta está desactivada. Habla con la dirección.');
    if (error.status === 429) throw new ApiError('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    if (error.status === 400) throw new ApiError('Código de escuela, usuario o contraseña incorrectos.');
    throw toApiError(error);
  }
  const me = await getMe();
  if (!me) {
    await sb.auth.signOut({ scope: 'local' });
    throw new ApiError('Esta cuenta o escuela no está activa. Habla con la dirección.');
  }
  rpc('touch_login').catch(() => {});
  return me;
}

/** Icon of the school with this code (current or old), for the login screen. Null if unknown. */
export const schoolBranding = (code) => rpc('school_branding', { p_code: code }).catch(() => null);

/** Tells the school's administration someone forgot their password. Never reveals if the account exists. */
export const requestPasswordHelp = (schoolCode, username) =>
  rpc('request_password_help', { p_school_code: schoolCode, p_username: username });

export async function signOut() {
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
}

export async function changePassword(currentPassword, newPassword) {
  const { data } = await sb.auth.getUser();
  if (!data.user) throw unauthorized();
  const { error: loginError } = await sb.auth.signInWithPassword({ email: data.user.email, password: currentPassword });
  if (loginError) throw new ApiError('La contraseña actual no es correcta.');
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) {
    if (error.code === 'same_password') throw new ApiError('La nueva contraseña debe ser diferente.');
    if (error.code === 'weak_password') throw new ApiError('Esa contraseña es muy débil. Elige otra.');
    throw toApiError(error);
  }
  await rpc('password_changed');
  // Close the session on other devices.
  sb.auth.signOut({ scope: 'others' }).catch(() => {});
}

export const updateMyContact = (email, phone) => rpc('update_my_contact', { p_email: email || null, p_phone: phone || null });

// ---- Ausencias -------------------------------------------------------------

export const myAbsences = (userId) =>
  run(
    sb
      .from('absences_v')
      .select('*')
      .eq('user_id', userId)
      .order('start_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(300),
  );

export function schoolAbsences({ from, to, status, q, user_id: userId } = {}) {
  let query = sb.from('absences_v').select('*');
  if (from) query = query.gte('end_date', from);
  if (to) query = query.lte('start_date', to);
  if (status === 'active') query = query.neq('status', 'cancelled');
  else if (['pending', 'received', 'cancelled'].includes(status)) query = query.eq('status', status);
  if (q) query = query.ilike('employee_name', `%${q.replace(/[%_,()]/g, ' ').slice(0, 100)}%`);
  if (userId) query = query.eq('user_id', userId);
  return run(query.order('start_date', { ascending: false }).order('id', { ascending: false }).limit(500));
}

export async function dashboard(today = todayStr()) {
  const horizon = addDays(today, 14);
  const active = () => sb.from('absences_v').select('*').neq('status', 'cancelled');
  const [todayList, upcoming, pending] = await Promise.all([
    run(active().lte('start_date', today).gte('end_date', today).order('partial').order('employee_name')),
    run(active().gt('start_date', today).lte('start_date', horizon).order('start_date').order('employee_name')),
    run(sb.from('absences_v').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(50)),
  ]);
  return {
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
  };
}

export async function getAbsence(id) {
  const [absence, attachments, comments, history] = await Promise.all([
    run(sb.from('absences_v').select('*').eq('id', id).maybeSingle()),
    run(sb.from('attachments').select('*').eq('absence_id', id).order('id')),
    run(sb.from('comments').select('*').eq('absence_id', id).order('id')),
    run(sb.from('absence_history').select('*').eq('absence_id', id).order('id')),
  ]);
  if (!absence) throw new ApiError('No se encontró la ausencia.', 404);
  if (attachments.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(attachments.map((a) => a.path), 3600);
    const urls = new Map((data || []).map((d) => [d.path, d.signedUrl]));
    for (const a of attachments) a.url = urls.get(a.path) || null;
  }
  return { absence, attachments, comments, history };
}

const EXT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const ALLOWED_TYPES = new Set(Object.values(EXT_TYPES));

/** Phones sometimes send HEIC photos or Word files without a MIME type, so fall back to the extension. */
function fileType(file) {
  if (ALLOWED_TYPES.has(file.type)) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_TYPES[ext] || null;
}

export function checkFile(file) {
  if (!fileType(file)) return `“${file.name}” no es un tipo permitido. Usa PDF, foto o Word.`;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `“${file.name}” pesa más de ${MAX_UPLOAD_MB} MB.`;
  return null;
}

async function uploadFiles(files, me) {
  const uploaded = [];
  try {
    for (const file of files) {
      const type = fileType(file);
      const ext = Object.keys(EXT_TYPES).find((k) => EXT_TYPES[k] === type) || 'bin';
      const path = `${me.school.id}/${me.user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: type, upsert: false });
      if (error) {
        throw new ApiError(
          /size|large/i.test(error.message) ? `“${file.name}” es demasiado grande.` : `No se pudo subir “${file.name}”.`,
        );
      }
      uploaded.push({ path, name: file.name });
    }
    return uploaded;
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

function removeFiles(paths) {
  if (paths.length) sb.storage.from(BUCKET).remove(paths).catch(() => {});
}

export async function createAbsence(me, v, files) {
  const uploaded = await uploadFiles(files, me);
  try {
    return await rpc('create_absence', {
      p_start_date: v.start_date,
      p_end_date: v.end_date || null,
      p_partial: v.partial === '1',
      p_start_time: v.partial === '1' ? v.start_time || null : null,
      p_end_time: v.partial === '1' ? v.end_time || null : null,
      p_category: v.category || null,
      p_reason: v.reason || null,
      p_coverage_notes: v.coverage_notes || null,
      p_user_id: v.user_id || null,
      p_today: todayStr(),
      p_files: uploaded,
    });
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

export async function addAttachments(me, absenceId, files) {
  const uploaded = await uploadFiles(files, me);
  try {
    await rpc('add_attachments', { p_absence_id: absenceId, p_files: uploaded });
  } catch (err) {
    removeFiles(uploaded.map((f) => f.path));
    throw err;
  }
}

export async function deleteAttachment(id) {
  const path = await rpc('delete_attachment', { p_id: id });
  removeFiles([path]);
}

export const receiveAbsence = (id, comment) => rpc('receive_absence', { p_id: id, p_comment: comment || null });
export const setCoverage = (id, substitute) => rpc('set_coverage', { p_id: id, p_substitute: substitute || null });
export const addComment = (id, body) => rpc('add_comment', { p_id: id, p_body: body });
/** reason: 'no_absence' | 'error' | 'other' (note required for 'other'). */
export const cancelAbsence = (id, reason, note) =>
  rpc('cancel_absence', { p_id: id, p_reason: reason, p_note: note || null });

export const updateAbsence = (id, v) =>
  rpc('update_absence', {
    p_id: id,
    p_start_date: v.start_date,
    p_end_date: v.end_date || null,
    p_partial: v.partial === '1',
    p_start_time: v.partial === '1' ? v.start_time || null : null,
    p_end_time: v.partial === '1' ? v.end_time || null : null,
    p_category: v.category || null,
    p_reason: v.reason || null,
    p_coverage_notes: v.coverage_notes || null,
    p_note: v.note || null,
    p_today: todayStr(),
  });

// ---- Avisos -----------------------------------------------------------------

export async function listNotifications() {
  const [notifications, unread] = await Promise.all([
    run(sb.from('notifications').select('*').order('id', { ascending: false }).limit(100)),
    unreadCount(),
  ]);
  return { notifications, unread };
}

export async function unreadCount() {
  const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  if (error) throw toApiError(error);
  return count || 0;
}

export const markNotificationRead = (id) => rpc('mark_notification_read', { p_id: id });
export const markAllNotificationsRead = () => rpc('mark_all_notifications_read');

export function savePushSubscription(sub) {
  const json = sub.toJSON();
  return rpc('save_push_subscription', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
}
export const deletePushSubscription = (endpoint) => rpc('delete_push_subscription', { p_endpoint: endpoint });
export const testPush = () => rpc('test_push');

// ---- Personal (dirección) ------------------------------------------------------

function withRoleLabel(e) {
  return e && { ...e, role_label: ROLE_LABELS[e.role] };
}

export async function listEmployees() {
  const rows = await run(
    sb.from('employees_v').select('*').order('active', { ascending: false }).order('full_name'),
  );
  return rows.map(withRoleLabel);
}

export async function getEmployee(id) {
  const row = await run(sb.from('employees_v').select('*').eq('id', id).maybeSingle());
  if (!row) throw new ApiError('Empleado no encontrado.', 404);
  return withRoleLabel(row);
}

export const createEmployee = (v) => callFunction('admin', { action: 'create_employee', ...v });
export const updateEmployee = (id, v) => callFunction('admin', { action: 'update_employee', id, ...v });
export const resetEmployeePassword = (id) => callFunction('admin', { action: 'reset_password', id });
export const deleteEmployee = (id) => callFunction('admin', { action: 'delete_employee', id });
export const setAdminPassword = (current, next) =>
  callFunction('admin', { action: 'set_admin_password', current_password: current, new_password: next });
/** target: 'main' (absences channel) or 'password' (forgotten-password channel). */
export const testTeams = (target = 'main') => callFunction('admin', { action: 'test_teams', target });

// ---- Correo y mensajes -------------------------------------------------------------

export const saveEmailAccount = (v) =>
  rpc('save_email_account', {
    p_provider: v.provider,
    p_from_email: v.from_email,
    p_from_name: v.from_name || null,
    p_password: v.password || null,
    p_smtp_host: v.smtp_host || null,
    p_smtp_port: v.smtp_port ? Number(v.smtp_port) : null,
    p_smtp_user: v.smtp_user || null,
  });
export const removeEmailAccount = () => rpc('remove_email_account');
/** Null subject and body restore the default text. */
export const saveWelcomeTemplate = (subject, body) => rpc('save_welcome_template', { p_subject: subject, p_body: body });
export const testEmail = () => callFunction('admin', { action: 'test_email' });
export const sendCredentials = (id, password) => callFunction('admin', { action: 'send_credentials', id, password });
/** to: 'all' | 'teacher' | 'secretary' | 'director' | [employee ids] */
export const sendMessage = ({ to, subject, body, email }) =>
  callFunction('admin', { action: 'send_message', to, subject, body, email: !!email });

/** kind 'welcome' (subject/body = template being edited) or 'message'. Returns { subject, html }. */
export const previewEmail = (kind, subject, body) => callFunction('admin', { action: 'preview_email', kind, subject, body });

/** Moves every account of the school to the new code and tells everyone. */
export const changeSchoolCode = (code) => callFunction('admin', { action: 'change_school_code', code });

export const listMessages = () =>
  run(sb.from('messages').select('*').order('created_at', { ascending: false }).limit(100));

export async function getMessage(id) {
  const [message, recipients] = await Promise.all([
    run(sb.from('messages').select('*').eq('id', id).maybeSingle()),
    run(sb.from('message_recipients').select('user_id, email_status, profile:profiles(full_name, email)').eq('message_id', id)),
  ]);
  if (!message) throw new ApiError('No se encontró el mensaje.', 404);
  recipients.sort((a, b) => (a.profile?.full_name || '').localeCompare(b.profile?.full_name || ''));
  return { message, recipients };
}

// ---- Escuela ---------------------------------------------------------------------

export async function getSchool(schoolId) {
  const [school, settings] = await Promise.all([
    run(sb.from('schools').select('id, code, name, created_at').eq('id', schoolId).single()),
    run(sb.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle()),
  ]);
  return { ...school, ...(settings || { teams_enabled: true, teams_include_reason: true }) };
}

export const updateSchool = (v) =>
  rpc('update_school', {
    p_name: v.name ?? null,
    p_teams_webhook_url: v.teams_webhook_url ?? null,
    p_teams_enabled: v.teams_enabled ?? null,
    p_teams_include_reason: v.teams_include_reason ?? null,
    p_update_teams_url: 'teams_webhook_url' in v,
    p_teams_password_webhook_url: v.teams_password_webhook_url ?? null,
    p_update_teams_password_url: 'teams_password_webhook_url' in v,
  });

// ---- Datos y reportes ------------------------------------------------------------

function absenceDays(a, from, to) {
  if (a.partial) return 0.5;
  const s = from && a.start_date < from ? from : a.start_date;
  const e = to && a.end_date > to ? to : a.end_date;
  return e < s ? 0 : weekdays(s, e);
}

export async function stats(from, to) {
  const rows = await schoolAbsences({ from, to, status: 'active' });
  const byEmployee = new Map();
  const byCategory = new Map();
  let totalDays = 0;
  for (const a of rows) {
    const days = absenceDays(a, from, to);
    totalDays += days;
    const e = byEmployee.get(a.user_id) || { user_id: a.user_id, full_name: a.employee_name, count: 0, days: 0 };
    e.count++;
    e.days += days;
    byEmployee.set(a.user_id, e);
    const key = a.category || 'sin_especificar';
    byCategory.set(key, (byCategory.get(key) || 0) + 1);
  }
  return {
    totals: {
      absences: rows.length,
      days: totalDays,
      employees: byEmployee.size,
      pending: rows.filter((a) => a.status === 'pending').length,
    },
    by_employee: [...byEmployee.values()].sort((a, b) => b.days - a.days || b.count - a.count),
    by_category: [...byCategory.entries()]
      .map(([category, count]) => ({ category, label: CATEGORIES[category] || 'Sin especificar', count }))
      .sort((a, b) => b.count - a.count),
  };
}

function download(filename, content, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const HISTORY_ACTIONS = { edited: 'Modificada', cancelled: 'Cancelada', received: 'Recibida' };

const ABSENCE_COLUMNS = [
  { header: 'ID', width: 7 },
  { header: 'Empleado', width: 26 },
  { header: 'Puesto', width: 18 },
  { header: 'Desde', width: 12 },
  { header: 'Hasta', width: 12 },
  { header: 'Días laborables', width: 10 },
  { header: 'Horario', width: 15 },
  { header: 'Tipo', width: 20 },
  { header: 'Causa', width: 40, wrap: true },
  { header: 'Instrucciones para cubrir', width: 40, wrap: true },
  { header: 'Estado', width: 11 },
  { header: 'Recibida por', width: 22 },
  { header: 'Fecha recibida', width: 17 },
  { header: 'Cubierto por', width: 24 },
  { header: 'Documentos', width: 11 },
  { header: 'Comentarios', width: 12 },
  { header: 'Registrada por', width: 22 },
  { header: 'Creada', width: 17 },
  { header: 'Cancelada', width: 17 },
  { header: 'Motivo de cancelación', width: 30, wrap: true },
];

function scheduleLabel(a) {
  if (!a.partial) return 'Día completo';
  const t = (v) => (v ? v.slice(0, 5) : '');
  return a.end_time ? `${t(a.start_time)} – ${t(a.end_time)}` : `Desde ${t(a.start_time)}`;
}

function absenceRow(a, cancelReasons = new Map()) {
  return [
    a.id, a.employee_name, a.employee_position, xDate(a.start_date), xDate(a.end_date), absenceDays(a),
    scheduleLabel(a), CATEGORIES[a.category] || '', a.reason, a.coverage_notes, STATUS[a.status]?.label,
    a.received_by_name, xDateTime(a.received_at), a.substitute, a.attachment_count, a.comment_count,
    a.created_by_name, xDateTime(a.created_at), xDateTime(a.cancelled_at), cancelReasons.get(a.id),
  ];
}

const absencesQuery = ({ from, to } = {}) => () => {
  let q = sb.from('absences_v').select('*');
  if (from) q = q.gte('end_date', from);
  if (to) q = q.lte('start_date', to);
  return q.order('start_date').order('id');
};

export async function exportAbsencesXlsx(code, { from, to } = {}) {
  const rows = await fetchAll(absencesQuery({ from, to }));
  const history = await fetchByIds('absence_history', 'absence_id', rows.filter((a) => a.status === 'cancelled').map((a) => a.id));
  const reasons = new Map(history.filter((h) => h.action === 'cancelled').map((h) => [h.absence_id, h.note]));
  const suffix = from || to ? `_${from || 'inicio'}_${to || 'hoy'}` : '';
  download(
    `ausencias_${code}${suffix}.xlsx`,
    buildXlsx([{ name: 'Ausencias', columns: ABSENCE_COLUMNS, rows: rows.map((a) => absenceRow(a, reasons)) }]),
  );
}

export async function exportEmployeesXlsx(code) {
  const rows = await listEmployees();
  const columns = [
    { header: 'Nombre', width: 28 }, { header: 'Usuario', width: 18 }, { header: 'Rol', width: 14 },
    { header: 'Puesto', width: 20 }, { header: 'Correo', width: 28 }, { header: 'Teléfono', width: 15 },
    { header: 'Núm. empleado', width: 14 }, { header: 'Activo', width: 8 }, { header: 'Ausencias', width: 10 },
    { header: 'Último acceso', width: 17 }, { header: 'Creado', width: 17 },
  ];
  download(
    `empleados_${code}.xlsx`,
    buildXlsx([{
      name: 'Personal',
      columns,
      rows: rows.map((u) => [
        u.full_name, u.username, ROLE_LABELS[u.role], u.position, u.email, u.phone, u.employee_number,
        u.active ? 'Sí' : 'No', u.absence_count, xDateTime(u.last_login_at), xDateTime(u.created_at),
      ]),
    }]),
  );
}

export async function exportBackupJson(school) {
  const all = (table, select = '*') => fetchAll(() => sb.from(table).select(select).order('id'));
  const [employees, absences, history, comments, attachments] = await Promise.all([
    run(sb.from('profiles').select('id, role, username, full_name, email, phone, employee_number, position, active, last_login_at, created_at')),
    all('absences'),
    all('absence_history'),
    all('comments'),
    all('attachments', 'id, absence_id, uploaded_by, uploaded_by_name, original_name, mime, size, created_at'),
  ]);
  const backup = {
    generated_at: new Date().toISOString(),
    school: { code: school.code, name: school.name },
    employees, absences, absence_history: history, comments, attachments,
  };
  download(`respaldo_${school.code}_${todayStr()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

// ---- Archivo anual -------------------------------------------------------------------
// A period is archived by the day each absence starts, so an absence that crosses the end of the
// school year belongs to the year in which it began.

/** First day with data, to offer the school years that exist. */
export async function firstAbsenceDate() {
  const rows = await run(sb.from('absences').select('start_date').order('start_date').limit(1));
  return rows[0]?.start_date || null;
}

export const archiveRuns = () => run(sb.from('archive_runs').select('*').order('created_at', { ascending: false }).limit(5));

export async function archiveData(from, to) {
  const absences = await fetchAll(() =>
    sb.from('absences_v').select('*').gte('start_date', from).lte('start_date', to).order('start_date').order('id'),
  );
  const ids = absences.map((a) => a.id);
  const [attachments, comments, history] = await Promise.all([
    fetchByIds('attachments', 'absence_id', ids),
    fetchByIds('comments', 'absence_id', ids),
    fetchByIds('absence_history', 'absence_id', ids),
  ]);
  const byStatus = { pending: 0, received: 0, cancelled: 0 };
  for (const a of absences) byStatus[a.status]++;
  return {
    from, to, absences, attachments, comments, history, byStatus,
    bytes: attachments.reduce((n, f) => n + (f.size || 0), 0),
  };
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'archivo';

/** Where each document goes inside the ZIP: one folder per absence. */
function zipPaths(data) {
  const absences = new Map(data.absences.map((a) => [a.id, a]));
  const used = new Set();
  const paths = new Map();
  for (const f of data.attachments) {
    const a = absences.get(f.absence_id);
    const folder = `${a.start_date} ${safeName(a.employee_name)} (#${a.id})`;
    let name = safeName(f.original_name);
    for (let n = 2; used.has(`${folder}/${name}`); n++) name = safeName(f.original_name).replace(/(\.[^.]*)?$/, ` (${n})$1`);
    used.add(`${folder}/${name}`);
    paths.set(f.id, `${folder}/${name}`);
  }
  return paths;
}

export function exportArchiveXlsx(school, data) {
  const names = new Map(data.absences.map((a) => [a.id, a.employee_name]));
  const reasons = new Map(data.history.filter((h) => h.action === 'cancelled').map((h) => [h.absence_id, h.note]));
  const paths = zipPaths(data);

  const perEmployee = new Map();
  for (const a of data.absences) {
    if (a.status === 'cancelled') continue;
    const e = perEmployee.get(a.user_id) || [a.employee_name, a.employee_position, 0, 0, 0];
    e[2]++;
    e[3] += absenceDays(a);
    if (a.status === 'pending') e[4]++;
    perEmployee.set(a.user_id, e);
  }

  const blob = buildXlsx([
    { name: 'Ausencias', columns: ABSENCE_COLUMNS, rows: data.absences.map((a) => absenceRow(a, reasons)) },
    {
      name: 'Por empleado',
      columns: [
        { header: 'Empleado', width: 28 }, { header: 'Puesto', width: 20 }, { header: 'Ausencias', width: 11 },
        { header: 'Días laborables', width: 15 }, { header: 'Sin confirmar', width: 13 },
      ],
      rows: [...perEmployee.values()].sort((x, y) => y[3] - x[3]),
    },
    {
      name: 'Historial',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Fecha', width: 17 },
        { header: 'Acción', width: 12 }, { header: 'Por', width: 22 }, { header: 'Cambios', width: 60, wrap: true },
        { header: 'Nota', width: 40, wrap: true },
      ],
      rows: data.history.map((h) => [
        h.absence_id, names.get(h.absence_id), xDateTime(h.created_at), HISTORY_ACTIONS[h.action], h.actor_name,
        (h.changes || []).map((c) => `${c.label}: ${c.before || '—'} → ${c.after || '—'}`).join('\n'), h.note,
      ]),
    },
    {
      name: 'Comentarios',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Fecha', width: 17 },
        { header: 'Autor', width: 22 }, { header: 'Rol', width: 14 }, { header: 'Comentario', width: 60, wrap: true },
      ],
      rows: data.comments.map((c) => [
        c.absence_id, names.get(c.absence_id), xDateTime(c.created_at), c.author_name, ROLE_LABELS[c.author_role], c.body,
      ]),
    },
    {
      name: 'Documentos',
      columns: [
        { header: 'Ausencia', width: 9 }, { header: 'Empleado', width: 26 }, { header: 'Archivo', width: 30 },
        { header: 'Tamaño (KB)', width: 12 }, { header: 'Subido por', width: 22 }, { header: 'Fecha', width: 17 },
        { header: 'Carpeta en el ZIP', width: 60 },
      ],
      rows: data.attachments.map((f) => [
        f.absence_id, names.get(f.absence_id), f.original_name, Math.round((f.size || 0) / 1024), f.uploaded_by_name,
        xDateTime(f.created_at), paths.get(f.id),
      ]),
    },
  ]);
  download(`archivo_${school.code}_${data.from}_${data.to}.xlsx`, blob);
}

/** Downloads every document of the period and saves them in one ZIP. onProgress(done, total). */
export async function exportArchiveZip(school, data, onProgress = () => {}) {
  const paths = zipPaths(data);
  const files = [];
  const failed = [];
  let done = 0;
  for (let i = 0; i < data.attachments.length; i += 100) {
    const batch = data.attachments.slice(i, i + 100);
    const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrls(batch.map((f) => f.path), 600);
    if (error) throw toApiError(error);
    const urls = new Map((signed || []).map((d) => [d.path, d.signedUrl]));
    // A few downloads at a time.
    const queue = [...batch];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          try {
            const res = await fetch(urls.get(f.path));
            if (!res.ok) throw new Error(String(res.status));
            files.push({ name: paths.get(f.id), data: new Uint8Array(await res.arrayBuffer()) });
          } catch {
            failed.push(f.original_name);
          }
          onProgress(++done, data.attachments.length);
        }
      }),
    );
  }
  if (failed.length) {
    throw new ApiError(`No se pudieron descargar ${failed.length} documento(s). Revisa tu conexión e inténtalo de nuevo.`);
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  download(`documentos_${school.code}_${data.from}_${data.to}.zip`, zip(files));
}

export const archivePurge = (from, to) => callFunction('admin', { action: 'archive_purge', from, to, confirm: 'BORRAR' });

// ---- Plataforma --------------------------------------------------------------------

// The platform password goes last so a payload field can never replace it.
export const platform = (password, action, payload = {}) =>
  callFunction('platform', { ...payload, action, password }, { auth: false });

// ---- Keep the app in sync when the session ends elsewhere ----------------------

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') window.dispatchEvent(new CustomEvent('lah:signed-out'));
});

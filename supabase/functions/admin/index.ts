// School administration actions that need Supabase Auth admin rights or the school's email account:
// employees (create, edit, deactivate, reset password, delete, email their access), messages to the staff,
// the school admin password, the Teams and email tests, and freeing space after an archive.
// Only the school's "admin" account and directors can use it.
import {
  anonClient,
  authEmail,
  generatePassword,
  HttpError,
  json,
  optText,
  readJson,
  reqText,
  serve,
  serviceClient,
  validatePassword,
} from '../_shared/http.ts';
import { deleteAbsences } from '../_shared/cleanup.ts';
import { loadEmailAccount, sendEmails } from '../_shared/email.ts';
import { isEmail, renderTemplate } from '../_shared/email_format.ts';
import { buildCard, postToTeams } from '../_shared/teams.ts';

const db = serviceClient();
const EMPLOYEE_ROLES = ['director', 'secretary', 'teacher'];
const DUPLICATE = 'Ese usuario ya existe en esta escuela.';
const EMPLOYEE_FIELDS =
  'id, role, username, full_name, email, phone, employee_number, position, active, must_change_password, last_login_at, created_at, updated_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIENCES: Record<string, string> = {
  all: 'Todo el personal',
  teacher: 'Maestros',
  secretary: 'Secretaría',
  director: 'Dirección',
};

type Me = {
  id: string;
  school_id: string;
  role: string;
  full_name: string;
  email: string | null;
  school: { code: string; name: string };
};

async function currentManager(req: Request): Promise<Me> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
  if (!data.user) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
  const { data: me } = await db
    .from('profiles')
    .select('id, school_id, role, full_name, email, active, must_change_password, school:schools(code, name, active)')
    .eq('id', data.user.id)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const school = (me as any)?.school;
  if (!me || !me.active || !school?.active) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
  if (me.must_change_password) throw new HttpError(403, 'Debes cambiar tu contraseña antes de continuar.');
  if (!['admin', 'director'].includes(me.role)) throw new HttpError(403, 'No tienes permiso para realizar esta acción.');
  return { ...me, school } as Me;
}

async function loadEmployee(me: Me, id: unknown) {
  const { data } = await db
    .from('profiles')
    .select(EMPLOYEE_FIELDS)
    .eq('id', String(id))
    .eq('school_id', me.school_id)
    .neq('role', 'admin')
    .maybeSingle();
  if (!data) throw new HttpError(404, 'Empleado no encontrado.');
  return data;
}

async function parseUsername(me: Me, value: unknown, selfId: string | null = null): Promise<string> {
  const username = reqText(value, 100, 'El usuario').toLowerCase();
  if (/\s/.test(username)) throw new HttpError(400, 'El usuario no puede tener espacios.');
  if (username === 'admin') throw new HttpError(400, 'El usuario "admin" está reservado.');
  let q = db.from('profiles').select('id').eq('school_id', me.school_id).eq('username', username);
  if (selfId) q = q.neq('id', selfId);
  const { data } = await q.maybeSingle();
  if (data) throw new HttpError(409, DUPLICATE);
  return username;
}

function parseRole(value: unknown): string {
  const role = String(value || 'teacher');
  if (!EMPLOYEE_ROLES.includes(role)) throw new HttpError(400, 'Rol no válido.');
  return role;
}

/** Two people creating the same username at once: the second hits a unique constraint instead of our check. */
function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === 'email_exists' || error.code === '23505' || /already (been )?registered|duplicate/i.test(error.message || ''));
}

function parseDate(value: unknown, label: string): string {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new HttpError(400, `${label} no es una fecha válida.`);
  }
  return s;
}

async function appUrl(): Promise<string> {
  const { data } = await db.from('app_settings').select('value').eq('key', 'app_url').maybeSingle();
  return ((data?.value as { url?: string } | undefined)?.url || '').replace(/\/?$/, '/');
}

async function requireEmailAccount(me: Me) {
  const account = await loadEmailAccount(db, me.school_id);
  if (!account) {
    throw new HttpError(400, 'Primero conecta una cuenta de correo en Escuela y Teams → Correo electrónico.');
  }
  return account;
}

async function recordEmailStatus(me: Me, status: string) {
  await db
    .from('school_settings')
    .update({ email_last_status: (status === 'sent' ? 'ok' : status).slice(0, 300), email_last_at: new Date().toISOString() })
    .eq('school_id', me.school_id);
}

function check(error: { code?: string; message: string } | null, message = 'No se pudo guardar. Inténtalo de nuevo.') {
  if (error) {
    if (isDuplicate(error)) throw new HttpError(409, DUPLICATE);
    console.error(error);
    throw new HttpError(500, message);
  }
}

const actions: Record<string, (me: Me, b: Record<string, unknown>) => Promise<Response>> = {
  async create_employee(me, b) {
    const fullName = reqText(b.full_name, 120, 'El nombre');
    const email = optText(b.email, 200, 'El correo');
    const username = await parseUsername(me, b.username || email);
    const role = parseRole(b.role);
    const password = validatePassword(b.password ? String(b.password) : generatePassword());

    const { data: created, error } = await db.auth.admin.createUser({
      email: await authEmail(me.school.code, username),
      password,
      email_confirm: true,
      app_metadata: { school_id: me.school_id },
    });
    if (error || !created.user) {
      check(error, 'No se pudo crear la cuenta del empleado.');
      throw new HttpError(500, 'No se pudo crear la cuenta del empleado.');
    }
    const { data: employee, error: insertError } = await db
      .from('profiles')
      .insert({
        id: created.user.id,
        school_id: me.school_id,
        role,
        username,
        full_name: fullName,
        email,
        phone: optText(b.phone, 40, 'El teléfono'),
        employee_number: optText(b.employee_number, 40, 'El número de empleado'),
        position: optText(b.position, 120, 'El puesto'),
        must_change_password: true,
      })
      .select(EMPLOYEE_FIELDS)
      .single();
    if (insertError) {
      await db.auth.admin.deleteUser(created.user.id);
      check(insertError);
    }
    return json({ employee, temp_password: password }, 201);
  },

  async update_employee(me, b) {
    const employee = await loadEmployee(me, b.id);
    const isSelf = employee.id === me.id;
    const next = {
      full_name: 'full_name' in b ? reqText(b.full_name, 120, 'El nombre') : employee.full_name,
      username: 'username' in b ? await parseUsername(me, b.username, employee.id) : employee.username,
      email: 'email' in b ? optText(b.email, 200, 'El correo') : employee.email,
      phone: 'phone' in b ? optText(b.phone, 40, 'El teléfono') : employee.phone,
      employee_number: 'employee_number' in b ? optText(b.employee_number, 40, 'El número de empleado') : employee.employee_number,
      position: 'position' in b ? optText(b.position, 120, 'El puesto') : employee.position,
      role: 'role' in b ? parseRole(b.role) : employee.role,
      active: 'active' in b ? b.active === true || b.active === 'true' : employee.active,
      updated_at: new Date().toISOString(),
    };
    if (isSelf && (next.role !== employee.role || !next.active)) {
      throw new HttpError(400, 'No puedes cambiar tu propio rol ni desactivar tu propia cuenta.');
    }
    const authChanges: Record<string, unknown> = {};
    if (next.username !== employee.username) {
      authChanges.email = await authEmail(me.school.code, next.username);
      authChanges.email_confirm = true;
    }
    // A ban blocks new logins and token refreshes; RLS already hides everything from inactive profiles.
    if (next.active !== employee.active) authChanges.ban_duration = next.active ? 'none' : '876000h';
    if (Object.keys(authChanges).length) {
      const { error } = await db.auth.admin.updateUserById(employee.id, authChanges);
      check(error, 'No se pudo actualizar el acceso del empleado.');
    }
    const { data, error } = await db.from('profiles').update(next).eq('id', employee.id).select(EMPLOYEE_FIELDS).single();
    check(error);
    return json({ employee: data });
  },

  async reset_password(me, b) {
    const employee = await loadEmployee(me, b.id);
    const password = validatePassword(b.password ? String(b.password) : generatePassword());
    const { error } = await db.auth.admin.updateUserById(employee.id, { password });
    check(error, 'No se pudo cambiar la contraseña.');
    await db
      .from('profiles')
      .update({ must_change_password: true, password_help_at: null, updated_at: new Date().toISOString() })
      .eq('id', employee.id);
    return json({ temp_password: password });
  },

  async delete_employee(me, b) {
    const employee = await loadEmployee(me, b.id);
    if (employee.id === me.id) throw new HttpError(400, 'No puedes eliminar tu propia cuenta.');
    const { count } = await db.from('absences').select('id', { count: 'exact', head: true }).eq('user_id', employee.id);
    if (count) {
      throw new HttpError(
        409,
        'Este empleado tiene ausencias registradas. Desactívalo en lugar de eliminarlo para conservar el historial.',
      );
    }
    const { error } = await db.auth.admin.deleteUser(employee.id);
    check(error, 'No se pudo eliminar el empleado.');
    return json({ ok: true });
  },

  async set_admin_password(me, b) {
    const next = validatePassword(b.new_password);
    const { data: admin } = await db
      .from('profiles')
      .select('id')
      .eq('school_id', me.school_id)
      .eq('role', 'admin')
      .maybeSingle();
    if (!admin) throw new HttpError(404, 'No se encontró la cuenta de administración.');
    const client = anonClient();
    const { error: loginError } = await client.auth.signInWithPassword({
      email: await authEmail(me.school.code, 'admin'),
      password: String(b.current_password || ''),
    });
    if (loginError) throw new HttpError(400, 'La contraseña de administración actual no es correcta.');
    await client.auth.signOut();
    const { error } = await db.auth.admin.updateUserById(admin.id, { password: next });
    check(error, 'No se pudo cambiar la contraseña.');
    return json({ ok: true });
  },

  async test_teams(me, b) {
    const passwordChannel = b.target === 'password';
    const { data: settings } = await db.from('school_settings').select('*').eq('school_id', me.school_id).maybeSingle();
    const url = passwordChannel ? settings?.teams_password_webhook_url : settings?.teams_webhook_url;
    if (!url) throw new HttpError(400, 'Primero guarda la URL del webhook de Teams.');
    if (!settings.teams_enabled) throw new HttpError(400, 'Las notificaciones de Teams están desactivadas.');
    const { data: app } = await db.from('app_settings').select('value').eq('key', 'app_url').maybeSingle();
    const what = passwordChannel ? 'Las solicitudes de contraseña olvidada' : 'Las nuevas ausencias del personal';
    let status = 'ok';
    try {
      await postToTeams(
        url,
        buildCard({
          title: '✅ Prueba de Leap Attendance Hub',
          subtitle: me.school.name,
          text: `${what} se publicarán en este canal. Prueba enviada por ${me.full_name}.`,
          linkUrl: (app?.value as { url?: string } | undefined)?.url,
        }),
      );
    } catch (err) {
      status = `error: ${(err as Error).message}`.slice(0, 300);
    }
    if (!passwordChannel) {
      await db
        .from('school_settings')
        .update({ teams_last_status: status, teams_last_at: new Date().toISOString() })
        .eq('school_id', me.school_id);
    }
    if (status !== 'ok') throw new HttpError(502, `No se pudo enviar a Teams: ${status.replace(/^error: /, '')}`);
    return json({ ok: true });
  },

  /** Emails the username and the temporary password that was just created or reset. */
  async send_credentials(me, b) {
    const employee = await loadEmployee(me, b.id);
    if (!isEmail(employee.email)) throw new HttpError(400, 'Este empleado no tiene un correo válido. Añádelo en su ficha.');
    const password = String(b.password || '');
    const account = await requireEmailAccount(me);
    // Only a password that really works is sent: the one shown right after creating or resetting it.
    const { data: matches, error: matchError } = await db.rpc('temp_password_matches', {
      p_user: employee.id,
      p_password: password,
    });
    check(matchError, 'No se pudo comprobar la contraseña.');
    if (!matches) {
      throw new HttpError(400, 'Esa contraseña ya no es válida. Usa «Restablecer contraseña» para generar una nueva.');
    }
    const { data: tpl } = await db
      .from('school_settings')
      .select('welcome_subject, welcome_body')
      .eq('school_id', me.school_id)
      .single();
    const vars = {
      nombre: employee.full_name,
      usuario: employee.username,
      'contraseña': password,
      contrasena: password,
      escuela: me.school.name,
      codigo: me.school.code,
      enlace: `${await appUrl()}?escuela=${encodeURIComponent(me.school.code)}`,
    };
    const [status] = await sendEmails(account, [{
      to: employee.email,
      toName: employee.full_name,
      replyTo: isEmail(me.email) ? me.email : null,
      subject: renderTemplate(tpl!.welcome_subject, vars),
      text: renderTemplate(tpl!.welcome_body, vars),
    }]);
    await recordEmailStatus(me, status);
    if (status !== 'sent') throw new HttpError(502, `No se pudo enviar el correo: ${status.replace(/^error: /, '')}`);
    return json({ ok: true, to: employee.email });
  },

  /** A message to everyone, a role or specific people: in-app notice + push, and optionally email. */
  async send_message(me, b) {
    const subject = reqText(b.subject, 150, 'El asunto').replace(/[\r\n]+/g, ' ');
    const body = reqText(b.body, 5000, 'El mensaje');
    const wantEmail = b.email === true;

    const { count: lastHour } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', me.school_id)
      .gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
    if ((lastHour ?? 0) >= 20) throw new HttpError(429, 'Se enviaron muchos mensajes en la última hora. Espera un poco.');

    let q = db
      .from('profiles')
      .select('id, full_name, email')
      .eq('school_id', me.school_id)
      .eq('active', true)
      .neq('role', 'admin')
      .neq('id', me.id);
    if (Array.isArray(b.to)) {
      const ids = b.to.map(String).filter((id) => UUID_RE.test(id)).slice(0, 500);
      if (!ids.length) throw new HttpError(400, 'Elige al menos una persona.');
      q = q.in('id', ids);
    } else if (typeof b.to === 'string' && b.to in AUDIENCES) {
      if (b.to !== 'all') q = q.eq('role', b.to);
    } else {
      throw new HttpError(400, 'Elige a quién enviar el mensaje.');
    }
    const { data: people, error } = await q.order('full_name');
    check(error, 'No se pudo leer el personal.');
    if (!people?.length) throw new HttpError(400, 'No hay personas activas en ese grupo.');
    const audience = Array.isArray(b.to)
      ? people.length <= 3 ? people.map((p) => p.full_name).join(', ') : `${people.length} personas`
      : AUDIENCES[b.to as string];
    // Fail before saving anything if email was asked for but isn't set up.
    const account = wantEmail ? await requireEmailAccount(me) : null;

    const { data: message, error: messageError } = await db
      .from('messages')
      .insert({
        school_id: me.school_id,
        sender_id: me.id,
        sender_name: me.full_name,
        subject,
        body,
        audience,
        recipients: people.length,
        email_requested: wantEmail,
      })
      .select('id')
      .single();
    check(messageError, 'No se pudo guardar el mensaje.');
    const id = message!.id as number;
    const rows = people.map((p) => ({
      message_id: id,
      user_id: p.id,
      school_id: me.school_id,
      email_status: wantEmail && !isEmail(p.email) ? 'no_email' : null,
    }));
    check((await db.from('message_recipients').insert(rows)).error, 'No se pudo guardar el mensaje.');
    const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
    // Each notification also goes out as a push (database trigger).
    check(
      (await db.from('notifications').insert(
        people.map((p) => ({ user_id: p.id, title: subject, body: `${me.full_name}: ${preview}`, link: `#/message/${id}` })),
      )).error,
      'No se pudieron crear los avisos.',
    );

    let emailed = 0;
    let failed = 0;
    const withEmail = people.filter((p) => isEmail(p.email));
    if (account && withEmail.length) {
      const link = `${await appUrl()}#/message/${id}`;
      const results = await sendEmails(
        account,
        withEmail.map((p) => ({
          to: p.email!,
          toName: p.full_name,
          replyTo: isEmail(me.email) ? me.email : null,
          subject,
          text: `${body}\n\n— ${me.full_name} · ${me.school.name}\n\nVer en Leap Attendance Hub: ${link}`,
        })),
      );
      const statusById = new Map(withEmail.map((p, i) => [p.id, results[i]]));
      emailed = results.filter((r) => r === 'sent').length;
      failed = results.length - emailed;
      await db
        .from('message_recipients')
        .upsert(rows.map((r) => ({ ...r, email_status: statusById.get(r.user_id) ?? r.email_status })));
      await db.from('messages').update({ emailed, email_failed: failed }).eq('id', id);
      await recordEmailStatus(me, results.find((r) => r !== 'sent') ?? 'sent');
    }
    return json({ id, recipients: people.length, emailed, email_failed: failed, no_email: wantEmail ? people.length - withEmail.length : 0 });
  },

  /** Sends a test email to the school's own address. */
  async test_email(me) {
    const account = await requireEmailAccount(me);
    const [status] = await sendEmails(account, [{
      to: account.from_email,
      subject: 'Prueba de Leap Attendance Hub',
      text:
        `Este es un correo de prueba de ${me.school.name}.\n\nSi lo recibiste, el correo está bien configurado: ` +
        `la app ya puede enviar los accesos del personal y tus mensajes.\n\nEnviado por ${me.full_name}.`,
    }]);
    await recordEmailStatus(me, status);
    if (status !== 'sent') throw new HttpError(502, status.replace(/^error: /, ''));
    return json({ ok: true, to: account.from_email });
  },

  /**
   * After downloading the Excel archive, the school deletes a finished period to free space.
   * Only received and cancelled absences go; pending ones stay until someone handles them.
   */
  async archive_purge(me, b) {
    if (me.role !== 'admin') throw new HttpError(403, 'Solo la cuenta de Administración puede liberar espacio.');
    if (b.confirm !== 'BORRAR') throw new HttpError(400, 'Escribe BORRAR para confirmar.');
    const from = parseDate(b.from, 'La fecha inicial');
    const to = parseDate(b.to, 'La fecha final');
    const today = new Date().toISOString().slice(0, 10);
    if (from > to) throw new HttpError(400, 'La fecha inicial debe ser antes de la final.');
    if (to >= today) throw new HttpError(400, 'Solo se pueden borrar períodos que ya terminaron.');
    // Same rule as the Excel archive: an absence belongs to the period in which it starts.
    const ids: number[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await db
        .from('absences')
        .select('id')
        .eq('school_id', me.school_id)
        .in('status', ['received', 'cancelled'])
        .gte('start_date', from)
        .lte('start_date', to)
        .lt('end_date', today)
        .order('id')
        .range(page * 1000, page * 1000 + 999);
      check(error, 'No se pudieron leer las ausencias.');
      ids.push(...(data || []).map((r) => r.id as number));
      if (!data || data.length < 1000) break;
    }
    if (!ids.length) throw new HttpError(400, 'No hay ausencias recibidas o canceladas en ese período.');
    let removed;
    try {
      removed = await deleteAbsences(db, ids);
    } catch (err) {
      console.error(err);
      throw new HttpError(500, 'No se pudo terminar de liberar el espacio. Inténtalo de nuevo.');
    }
    await db.from('archive_runs').insert({
      school_id: me.school_id,
      date_from: from,
      date_to: to,
      ...removed,
      actor_id: me.id,
      actor_name: me.full_name,
    });
    return json(removed);
  },
};

serve(async (req) => {
  const me = await currentManager(req);
  const body = await readJson(req);
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(me, body);
});

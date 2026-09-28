// School administration actions that need Supabase Auth admin rights:
// employees (create, edit, deactivate, reset password, delete), the school admin password and the Teams test.
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
import { buildCard, postToTeams } from '../_shared/teams.ts';

const db = serviceClient();
const EMPLOYEE_ROLES = ['director', 'secretary', 'teacher'];
const DUPLICATE = 'Ese usuario ya existe en esta escuela.';
const EMPLOYEE_FIELDS =
  'id, role, username, full_name, email, phone, employee_number, position, active, must_change_password, last_login_at, created_at, updated_at';

type Me = { id: string; school_id: string; role: string; full_name: string; school: { code: string; name: string } };

async function currentManager(req: Request): Promise<Me> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = token ? await db.auth.getUser(token) : { data: { user: null } };
  if (!data.user) throw new HttpError(401, 'Tu sesión expiró. Vuelve a iniciar sesión.');
  const { data: me } = await db
    .from('profiles')
    .select('id, school_id, role, full_name, active, must_change_password, school:schools(code, name, active)')
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
};

serve(async (req) => {
  const me = await currentManager(req);
  const body = await readJson(req);
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(me, body);
});

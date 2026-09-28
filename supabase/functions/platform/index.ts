// Platform panel: create and manage schools. Protected by the platform password
// (bcrypt hash stored in app_settings.platform_password).
import {
  authEmail,
  HttpError,
  json,
  readJson,
  reqText,
  serve,
  serviceClient,
  validatePassword,
} from '../_shared/http.ts';

const db = serviceClient();

function normalizeCode(code: unknown): string {
  return String(code || '').trim().toUpperCase();
}

function validateCode(code: string) {
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code)) {
    throw new HttpError(400, 'El código de escuela debe tener de 3 a 20 letras, números o guiones.');
  }
}

async function codeExists(code: string): Promise<boolean> {
  const { data } = await db.from('schools').select('id').eq('code', code).maybeSingle();
  return !!data;
}

/** Suggests a readable code from the school name, e.g. "Leap Academy" -> "LA-4821". */
async function suggestCode(name: string): Promise<string> {
  const initials =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 || /^[A-Z]/.test(w))
      .map((w) => w[0].toUpperCase())
      .join('')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6) || 'ESC';
  for (let i = 0; i < 50; i++) {
    const n = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
    const code = `${initials.padEnd(2, 'X')}-${n}`;
    if (!(await codeExists(code))) return code;
  }
  throw new HttpError(500, 'No se pudo generar un código único.');
}

async function adminOf(schoolId: unknown): Promise<{ id: string }> {
  const { data } = await db.from('profiles').select('id').eq('school_id', String(schoolId)).eq('role', 'admin').maybeSingle();
  if (!data) throw new HttpError(404, 'Escuela no encontrada.');
  return data;
}

const actions: Record<string, (b: Record<string, unknown>) => Promise<Response>> = {
  async list_schools() {
    const { data, error } = await db.rpc('platform_schools');
    if (error) throw error;
    return json({ schools: data });
  },

  async create_school(b) {
    const name = reqText(b.name, 150, 'El nombre de la escuela');
    const code = b.code ? normalizeCode(b.code) : await suggestCode(name);
    validateCode(code);
    if (await codeExists(code)) throw new HttpError(409, 'Ya existe una escuela con ese código.');
    const password = validatePassword(b.admin_password);

    const { data: school, error } = await db.from('schools').insert({ code, name }).select().single();
    if (error) throw error;
    const rollback = () => db.from('schools').delete().eq('id', school.id);
    await db.from('school_settings').insert({ school_id: school.id });

    const { data: created, error: authError } = await db.auth.admin.createUser({
      email: await authEmail(code, 'admin'),
      password,
      email_confirm: true,
      app_metadata: { school_id: school.id },
    });
    if (authError || !created.user) {
      await rollback();
      console.error(authError);
      throw new HttpError(500, 'No se pudo crear la cuenta de administración.');
    }
    const { error: profileError } = await db.from('profiles').insert({
      id: created.user.id,
      school_id: school.id,
      role: 'admin',
      username: 'admin',
      full_name: 'Administración',
    });
    if (profileError) {
      await db.auth.admin.deleteUser(created.user.id);
      await rollback();
      throw profileError;
    }
    return json({ school: { id: school.id, code, name } }, 201);
  },

  async set_school_active(b) {
    const { error } = await db.from('schools').update({ active: b.active === true }).eq('id', String(b.school_id));
    if (error) throw error;
    return json({ ok: true });
  },

  async reset_admin_password(b) {
    const admin = await adminOf(b.school_id);
    // b.password is the platform password; the new admin password comes in new_password.
    const password = validatePassword(b.new_password);
    const { error } = await db.auth.admin.updateUserById(admin.id, { password });
    if (error) throw error;
    return json({ ok: true });
  },
};

serve(async (req) => {
  const body = await readJson(req);
  const { data: ok } = await db.rpc('platform_check_password', { p_password: String(body.password || '') });
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, 'Contraseña de plataforma incorrecta.');
  }
  const action = actions[String(body.action)];
  if (!action) throw new HttpError(400, 'Acción no válida.');
  return action(body);
});

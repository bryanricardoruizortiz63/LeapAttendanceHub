-- Roles per school. The Administración account adds, renames and deletes roles (admin Edge Function) and
-- chooses what each one can do. profiles.role holds the role's key; "admin" is the school's Administración
-- account (system role, hidden and fixed). Everyone can report their own absences; permissions add the rest:
--   absences  see and confirm everyone's absences, coverage, comments, notices of new absences
--   staff     manage employees (accounts, passwords, access emails) and remove other people's documents
--   settings  school name, Teams, email account and welcome message
--   messages  send messages to the staff
--   reports   statistics, Excel exports, backup and the yearly archive
-- coverage: absences of people with this role need someone to cover them (teachers), so the app asks for
-- coverage notes and shows "Cobertura"; nursing, maintenance or security don't.

create table public.school_roles (
  school_id uuid not null references public.schools on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  permissions text[] not null default '{}'
    check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports']::text[])
    -- Managing staff and reports both need to see everyone's absences.
    check ('absences' = any(permissions) or not (permissions && array['staff', 'reports']::text[])),
  coverage boolean not null default true,
  system boolean not null default false,
  position int not null default 100,
  created_at timestamptz not null default now(),
  primary key (school_id, key)
);
create unique index school_roles_name on public.school_roles (school_id, lower(name));

alter table public.school_roles enable row level security;
create policy "Ver roles de mi escuela" on public.school_roles for select to authenticated
  using (school_id = (select private.my_school_id()));
revoke insert, update, delete, truncate on public.school_roles from anon, authenticated;
revoke all on public.school_roles from anon;

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'mantenimiento', 'Mantenimiento', '{}', false, false, 60),
    (p_school, 'seguridad', 'Seguridad', '{}', false, false, 70)
  on conflict do nothing
$$;

select private.add_default_roles(id) from public.schools;

create or replace function private.seed_school_roles()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.add_default_roles(new.id);
  return new;
end;
$$;

create trigger schools_seed_roles after insert on public.schools
  for each row execute function private.seed_school_roles();

-- A role in use can't be deleted (people have to be moved to another role first).
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_fkey
  foreign key (school_id, role) references public.school_roles (school_id, key);

-- ---------------------------------------------------------------------------
-- Permission checks
-- ---------------------------------------------------------------------------

/** Whether this profile's role has the permission (the Administración account has all). */
create or replace function private.can(me public.profiles, p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select me.id is not null and (
    me.role = 'admin'
    or exists (
      select 1 from public.school_roles r
      where r.school_id = me.school_id and r.key = me.role and p_perm = any(r.permissions)
    )
  )
$$;

/** For RLS: the signed-in person's permission. */
create or replace function private.has_perm(p_perm text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.can(private.my_profile(), p_perm), false)
$$;

-- Sees and confirms everyone's absences.
create or replace function private.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_perm('absences')
$$;

-- Has some management permission (reads the school settings, sees the staff list).
create or replace function private.is_manager()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.has_perm('staff') or private.has_perm('settings') or private.has_perm('messages') or private.has_perm('reports')
$$;

-- Who is told about new, changed and cancelled absences.
create or replace function private.staff_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.school_id = p_school and p.active and 'absences' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

-- Who is told when someone forgot their password.
create or replace function private.manager_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.school_id = p_school and p.active and 'staff' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

create or replace function private.load_absence(p_id bigint, me public.profiles)
returns public.absences
language plpgsql stable security definer set search_path = ''
as $$
declare
  a public.absences;
begin
  select * into a from public.absences where id = p_id and school_id = me.school_id;
  if a.id is null or (a.user_id <> me.id and not private.can(me, 'absences')) then
    raise exception 'No se encontró la ausencia.';
  end if;
  return a;
end;
$$;

revoke execute on function private.add_default_roles(uuid), private.seed_school_roles(),
  private.can(public.profiles, text) from public, anon, authenticated;
grant execute on function private.has_perm(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Same as before, with permissions instead of fixed roles
-- ---------------------------------------------------------------------------

create or replace function public.receive_absence(p_id bigint, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_comment text := private.clean_text(p_comment, 2000, 'El comentario');
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if a.status = 'pending' then
    update public.absences
    set status = 'received', received_by = me.id, received_by_name = me.full_name, received_at = now(), updated_at = now()
    where id = a.id;
    insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action)
    values (a.id, a.school_id, me.id, me.full_name, 'received');
    perform private.notify(
      array[a.user_id], 'Tu ausencia fue recibida ✅',
      coalesce(me.full_name || ': ' || left(v_comment, 140), 'Confirmada por ' || me.full_name || '.'),
      '#/absence/' || a.id
    );
  elsif v_comment is not null then
    perform private.notify(
      array[a.user_id], 'Nuevo comentario de ' || me.full_name, left(v_comment, 140), '#/absence/' || a.id
    );
  end if;
  if v_comment is not null then
    insert into public.comments (absence_id, user_id, author_name, author_role, body)
    values (a.id, me.id, me.full_name, me.role, v_comment);
  end if;
end;
$$;

create or replace function public.set_coverage(p_id bigint, p_substitute text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_sub text := private.clean_text(p_substitute, 300, 'La cobertura');
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  update public.absences set substitute = v_sub, updated_at = now() where id = a.id;
  if v_sub is not null and v_sub is distinct from a.substitute then
    perform private.notify(
      array[a.user_id], 'Se asignó cobertura para tu ausencia', v_sub || ' (por ' || me.full_name || ')',
      '#/absence/' || a.id
    );
  end if;
end;
$$;

create or replace function public.update_school(
  p_name text default null,
  p_teams_webhook_url text default null,
  p_teams_enabled boolean default null,
  p_teams_include_reason boolean default null,
  p_update_teams_url boolean default false,
  p_teams_password_webhook_url text default null,
  p_update_teams_password_url boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_url text := nullif(btrim(p_teams_webhook_url), '');
  v_pw_url text := nullif(btrim(p_teams_password_webhook_url), '');
  v_pattern text := '^https://([a-z0-9-]+\.)+(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|powerautomate\.com)(:443)?/';
  v_error text := 'La URL debe ser un webhook de Microsoft Teams o de Power Automate (Workflows) y comenzar con https://';
  v_old text;
begin
  if not private.can(me, 'settings') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if p_name is not null then
    if private.clean_text(p_name, 150, 'El nombre de la escuela') is null then
      raise exception 'El nombre de la escuela es requerido.';
    end if;
    update public.schools set name = btrim(p_name) where id = me.school_id;
  end if;

  insert into public.school_settings (school_id) values (me.school_id) on conflict do nothing;
  if p_update_teams_url then
    if v_url is not null and (char_length(v_url) > 2000 or v_url !~* v_pattern) then
      raise exception '%', v_error;
    end if;
    select teams_webhook_url into v_old from public.school_settings where school_id = me.school_id;
    update public.school_settings
    set teams_webhook_url = v_url,
        teams_last_status = case when v_url is distinct from v_old then null else teams_last_status end,
        teams_last_at = case when v_url is distinct from v_old then null else teams_last_at end
    where school_id = me.school_id;
  end if;
  if p_update_teams_password_url then
    if v_pw_url is not null and (char_length(v_pw_url) > 2000 or v_pw_url !~* v_pattern) then
      raise exception '%', v_error;
    end if;
    update public.school_settings set teams_password_webhook_url = v_pw_url where school_id = me.school_id;
  end if;
  update public.school_settings
  set teams_enabled = coalesce(p_teams_enabled, teams_enabled),
      teams_include_reason = coalesce(p_teams_include_reason, teams_include_reason)
  where school_id = me.school_id;
end;
$$;

create or replace function public.save_email_account(
  p_provider text,
  p_from_email text,
  p_from_name text default null,
  p_password text default null,
  p_smtp_host text default null,
  p_smtp_port int default null,
  p_smtp_user text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_from text := lower(btrim(p_from_email));
  v_name text := private.clean_text(p_from_name, 100, 'El nombre del remitente');
  v_password text := nullif(btrim(p_password), '');
  v_host text;
  v_port int;
  v_user text;
  v_secret uuid;
  v_secret_name text := 'email-password-' || me.school_id;
begin
  if not private.can(me, 'settings') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if p_provider is null or p_provider not in ('gmail', 'smtp') then
    raise exception 'Elige el tipo de cuenta de correo.';
  end if;
  if v_from is null or char_length(v_from) > 200 or v_from !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Escribe un correo válido para enviar.';
  end if;

  if p_provider = 'gmail' then
    v_host := 'smtp.gmail.com';
    v_port := 465;
    v_user := v_from;
    -- Google shows app passwords in groups of four letters.
    v_password := replace(v_password, ' ', '');
  else
    v_host := lower(btrim(p_smtp_host));
    v_port := coalesce(p_smtp_port, 465);
    v_user := coalesce(nullif(btrim(p_smtp_user), ''), v_from);
    if v_host is null or char_length(v_host) > 253
      or v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      raise exception 'Escribe un servidor SMTP válido (por ejemplo smtp-relay.brevo.com).';
    end if;
    if v_port in (25, 587) then
      raise exception 'Supabase bloquea los puertos 25 y 587. Usa el 465 (SSL) o el 2525.';
    end if;
    if v_port not between 1 and 65535 then
      raise exception 'Puerto no válido.';
    end if;
    if char_length(v_user) > 200 then
      raise exception 'El usuario SMTP es demasiado largo.';
    end if;
  end if;
  if char_length(v_password) > 500 then
    raise exception 'La contraseña es demasiado larga.';
  end if;

  insert into public.school_settings (school_id) values (me.school_id) on conflict do nothing;
  select email_secret_id into v_secret from public.school_settings where school_id = me.school_id;
  if v_secret is null then
    select id into v_secret from vault.secrets where name = v_secret_name;
  end if;
  if v_password is not null then
    if v_secret is null then
      v_secret := vault.create_secret(v_password, v_secret_name, 'Contraseña del correo de la escuela');
    else
      perform vault.update_secret(v_secret, v_password);
    end if;
  elsif v_secret is null then
    raise exception 'Escribe la contraseña de aplicación.';
  end if;

  update public.school_settings
  set email_provider = p_provider, email_from = v_from, email_from_name = v_name, smtp_host = v_host,
      smtp_port = v_port, smtp_user = v_user, email_secret_id = v_secret, email_last_status = null, email_last_at = null
  where school_id = me.school_id;
end;
$$;

create or replace function public.remove_email_account()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_secret uuid;
begin
  if not private.can(me, 'settings') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  select email_secret_id into v_secret from public.school_settings where school_id = me.school_id;
  update public.school_settings
  set email_provider = null, email_from = null, email_from_name = null, smtp_host = null, smtp_port = null,
      smtp_user = null, email_secret_id = null, email_last_status = null, email_last_at = null
  where school_id = me.school_id;
  -- Wipe the stored password; the empty Vault entry is reused if the school connects again.
  if v_secret is not null then
    perform vault.update_secret(v_secret, '');
  end if;
end;
$$;

create or replace function public.save_welcome_template(p_subject text default null, p_body text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_subject text := nullif(btrim(p_subject), '');
  v_body text := nullif(btrim(p_body), '');
begin
  if not private.can(me, 'settings') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  insert into public.school_settings (school_id) values (me.school_id) on conflict do nothing;
  if v_subject is null and v_body is null then
    update public.school_settings set welcome_subject = default, welcome_body = default where school_id = me.school_id;
    return;
  end if;
  if v_subject is null or v_body is null then
    raise exception 'Escribe el asunto y el mensaje.';
  end if;
  if char_length(v_subject) > 200 then
    raise exception 'El asunto es demasiado largo (máx. 200 caracteres).';
  end if;
  if char_length(v_body) > 5000 then
    raise exception 'El mensaje es demasiado largo (máx. 5000 caracteres).';
  end if;
  if position('{usuario}' in v_body) = 0 or position('{contraseña}' in v_body) = 0 then
    raise exception 'El mensaje debe incluir {usuario} y {contraseña} para que la persona pueda entrar.';
  end if;
  update public.school_settings set welcome_subject = v_subject, welcome_body = v_body where school_id = me.school_id;
end;
$$;

-- Same as before, plus my permissions and the school's roles (names, permissions, coverage).
create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password,
      'permissions', coalesce(to_jsonb(r.permissions), '[]'::jsonb),
      'coverage', coalesce(r.coverage and p.role <> 'admin', false)
    ),
    'school', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'icon_version', s.icon_version),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key, 'name', x.name, 'permissions', x.permissions, 'coverage', x.coverage)
        order by x.position, x.name)
      from public.school_roles x where x.school_id = s.id and not x.system
    ), '[]'::jsonb)
  )
  from public.profiles p
  join public.schools s on s.id = p.school_id
  left join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.id = auth.uid() and p.active and s.active
$$;

-- ---------------------------------------------------------------------------
-- Policies that depended on the fixed roles
-- ---------------------------------------------------------------------------

-- Anyone with a management permission sees the staff list (e.g. to pick message recipients).
alter policy "Ver perfiles de mi escuela" on public.profiles
  using (school_id = (select private.my_school_id())
    and (id = (select auth.uid()) or (select private.is_staff()) or (select private.is_manager())));

alter policy "Borrar excusas" on storage.objects
  using (
    bucket_id = 'excuses'
    and (storage.foldername(name))[1] = (select private.my_school_id())::text
    and ((storage.foldername(name))[2] = (select auth.uid())::text or (select private.has_perm('staff')))
  );

alter policy "Dirección ve los archivos anuales" on public.archive_runs
  using (school_id = (select private.my_school_id()) and (select private.has_perm('reports')));

alter policy "Ver mis mensajes" on public.message_recipients
  using (user_id = (select auth.uid()) or (school_id = (select private.my_school_id()) and (select private.has_perm('messages'))));

alter policy "Ver mensajes" on public.messages
  using (
    school_id = (select private.my_school_id())
    and ((select private.has_perm('messages'))
      or exists (select 1 from public.message_recipients r where r.message_id = id and r.user_id = (select auth.uid())))
  );

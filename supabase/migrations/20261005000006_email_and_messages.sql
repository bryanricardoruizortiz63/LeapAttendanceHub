-- 1) Each school can connect an email account (Gmail with an app password, or any SMTP server on
--    port 465/2525) to email staff their username + temporary password and the dirección's messages.
--    The password lives encrypted in Supabase Vault; only the Edge Functions can read it.
-- 2) An editable "welcome" template for the credentials email (and the copy/share text).
-- 3) Messages from the dirección to everyone, a role or specific people: in-app notice + push,
--    and optionally email.

alter table public.school_settings
  add column if not exists email_provider text check (email_provider in ('gmail', 'smtp')),
  add column if not exists email_from text check (char_length(email_from) <= 200),
  add column if not exists email_from_name text check (char_length(email_from_name) <= 100),
  add column if not exists smtp_host text check (char_length(smtp_host) <= 253),
  add column if not exists smtp_port int check (smtp_port between 1 and 65535),
  add column if not exists smtp_user text check (char_length(smtp_user) <= 200),
  add column if not exists email_secret_id uuid,
  add column if not exists email_last_status text,
  add column if not exists email_last_at timestamptz,
  add column if not exists welcome_subject text not null default 'Tu acceso a Leap Attendance Hub ({escuela})'
    check (char_length(welcome_subject) between 1 and 200),
  add column if not exists welcome_body text not null default $tpl$Hola {nombre}:

Ya puedes usar Leap Attendance Hub, la app de {escuela} para avisar cuando vas a faltar.

1. Abre este enlace desde tu teléfono:
{enlace}

2. Entra con estos datos:
   Usuario: {usuario}
   Contraseña temporal: {contraseña}

3. La app te pedirá crear tu propia contraseña.

4. Añádela a la pantalla de inicio para tenerla a mano:
   • iPhone (Safari): botón Compartir → “Añadir a pantalla de inicio”.
   • Android (Chrome): menú ⋮ → “Instalar app”.

5. En Perfil, activa las notificaciones para saber cuándo la dirección recibe tus ausencias.

Si tienes dudas, comunícate con la dirección.$tpl$ check (char_length(welcome_body) between 1 and 5000);

create table public.messages (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  sender_id uuid references public.profiles on delete set null,
  sender_name text not null,
  subject text not null check (char_length(subject) between 1 and 150),
  body text not null check (char_length(body) between 1 and 5000),
  audience text not null,
  recipients int not null default 0,
  email_requested boolean not null default false,
  emailed int not null default 0,
  email_failed int not null default 0,
  created_at timestamptz not null default now()
);
create index messages_school on public.messages (school_id, created_at desc);
create index messages_sender on public.messages (sender_id);

create table public.message_recipients (
  message_id bigint not null references public.messages on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  -- null: not emailed · 'sent' · 'no_email' · 'error: …'
  email_status text,
  primary key (message_id, user_id)
);
create index message_recipients_user on public.message_recipients (user_id);
create index message_recipients_school on public.message_recipients (school_id);

alter table public.messages enable row level security;
alter table public.message_recipients enable row level security;

-- message_recipients doesn't look at messages, so the two policies can't recurse.
create policy "Ver mis mensajes" on public.message_recipients for select to authenticated
  using (user_id = (select auth.uid()) or (school_id = (select private.my_school_id()) and (select private.is_manager())));

create policy "Ver mensajes" on public.messages for select to authenticated
  using (
    school_id = (select private.my_school_id())
    and ((select private.is_manager())
      or exists (select 1 from public.message_recipients r where r.message_id = id and r.user_id = (select auth.uid())))
  );

revoke insert, update, delete, truncate on public.messages, public.message_recipients from anon, authenticated;
revoke all on public.messages, public.message_recipients from anon;

-- ---------------------------------------------------------------------------

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
  if me.role not in ('admin', 'director') then
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
  if me.role not in ('admin', 'director') then
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

-- Null subject and body restore the default text.
create or replace function public.save_welcome_template(p_subject text default null, p_body text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_subject text := nullif(btrim(p_subject), '');
  v_body text := nullif(btrim(p_body), '');
begin
  if me.role not in ('admin', 'director') then
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

-- Only the Edge Functions (service_role) can read the decrypted password.
create or replace function public.email_account(p_school uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'provider', s.email_provider, 'from_email', s.email_from, 'from_name', coalesce(s.email_from_name, sc.name),
    'host', s.smtp_host, 'port', s.smtp_port, 'user', s.smtp_user, 'password', d.decrypted_secret)
  from public.school_settings s
  join public.schools sc on sc.id = s.school_id
  join vault.decrypted_secrets d on d.id = s.email_secret_id
  where s.school_id = p_school and s.email_provider is not null
$$;

-- Lets the server check that the password it is about to email is the employee's current one,
-- without signing in as them.
create or replace function public.temp_password_matches(p_user uuid, p_password text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
    from auth.users u where u.id = p_user and u.encrypted_password like '$2%'
  ), false)
$$;

revoke execute on function public.temp_password_matches(uuid, text) from public, anon, authenticated;
grant execute on function public.temp_password_matches(uuid, text) to service_role;

revoke execute on function
  public.save_email_account(text, text, text, text, text, int, text),
  public.remove_email_account(),
  public.save_welcome_template(text, text),
  public.email_account(uuid)
  from public, anon;
revoke execute on function public.email_account(uuid) from authenticated;
grant execute on function
  public.save_email_account(text, text, text, text, text, int, text),
  public.remove_email_account(),
  public.save_welcome_template(text, text)
  to authenticated;
grant execute on function public.email_account(uuid) to service_role;

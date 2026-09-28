-- Leap Attendance Hub — esquema en Supabase.
-- Cada escuela está aislada con Row Level Security: los usuarios solo ven filas de su escuela,
-- y los maestros solo sus propias ausencias. Los cambios de estado pasan por funciones (RPC)
-- que validan permisos y generan las notificaciones.

create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  name text not null check (char_length(name) between 1 and 150),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.school_settings (
  school_id uuid primary key references public.schools on delete cascade,
  teams_webhook_url text check (char_length(teams_webhook_url) <= 2000),
  teams_enabled boolean not null default true,
  teams_include_reason boolean not null default true,
  teams_last_status text,
  teams_last_at timestamptz
);

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  role text not null check (role in ('admin', 'director', 'secretary', 'teacher')),
  username text not null check (username = lower(username) and char_length(username) between 1 and 100),
  full_name text not null check (char_length(full_name) between 1 and 120),
  email text,
  phone text,
  employee_number text,
  position text,
  must_change_password boolean not null default false,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, username)
);
create index profiles_school_role on public.profiles (school_id, role);

create table public.absences (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_by uuid references public.profiles on delete set null,
  created_by_name text,
  start_date date not null,
  end_date date not null,
  partial boolean not null default false,
  start_time time,
  end_time time,
  category text check (category in ('enfermedad', 'cita_medica', 'personal', 'familiar', 'oficial', 'otro')),
  reason text check (char_length(reason) <= 1000),
  coverage_notes text check (char_length(coverage_notes) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'received', 'cancelled')),
  received_by uuid references public.profiles on delete set null,
  received_by_name text,
  received_at timestamptz,
  substitute text check (char_length(substitute) <= 300),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index absences_school_dates on public.absences (school_id, start_date, end_date);
create index absences_user on public.absences (user_id, start_date);
create index absences_created_by on public.absences (created_by);
create index absences_received_by on public.absences (received_by);

create table public.attachments (
  id bigint generated always as identity primary key,
  absence_id bigint not null references public.absences on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  uploaded_by uuid references public.profiles on delete set null,
  uploaded_by_name text,
  path text not null unique,
  original_name text not null,
  mime text not null,
  size integer not null,
  created_at timestamptz not null default now()
);
create index attachments_absence on public.attachments (absence_id);
create index attachments_school on public.attachments (school_id);
create index attachments_uploaded_by on public.attachments (uploaded_by);

create table public.comments (
  id bigint generated always as identity primary key,
  absence_id bigint not null references public.absences on delete cascade,
  user_id uuid references public.profiles on delete set null,
  author_name text not null,
  author_role text not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index comments_absence on public.comments (absence_id);
create index comments_user on public.comments (user_id);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on public.notifications (user_id, read_at);

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

-- Solo para el servidor (service_role): claves VAPID, URL de la función de avisos, etc.
create table public.app_settings (
  key text primary key,
  value jsonb not null
);

-- Cola de avisos externos (push y Teams) que procesa la Edge Function "notify".
create table public.outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('push', 'teams')),
  school_id uuid references public.schools on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  result text
);
create index outbox_school on public.outbox (school_id);

-- ---------------------------------------------------------------------------
-- Funciones auxiliares (esquema private: no se exponen en la API)
-- ---------------------------------------------------------------------------

create or replace function private.my_profile()
returns public.profiles
language sql stable security definer set search_path = ''
as $$
  select p.* from public.profiles p
  join public.schools s on s.id = p.school_id
  where p.id = auth.uid() and p.active and s.active
$$;

create or replace function private.my_school_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.school_id from public.profiles p
  join public.schools s on s.id = p.school_id
  where p.id = auth.uid() and p.active and s.active
$$;

create or replace function private.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p.role in ('admin', 'director', 'secretary') from public.profiles p
    join public.schools s on s.id = p.school_id
    where p.id = auth.uid() and p.active and s.active
  ), false)
$$;

create or replace function private.is_manager()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p.role in ('admin', 'director') from public.profiles p
    join public.schools s on s.id = p.school_id
    where p.id = auth.uid() and p.active and s.active
  ), false)
$$;

grant execute on function private.my_profile(), private.my_school_id(), private.is_staff(), private.is_manager()
  to authenticated, service_role;

create or replace function private.require_profile()
returns public.profiles
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles;
begin
  me := private.my_profile();
  if me.id is null then
    raise exception 'Tu sesión expiró. Vuelve a iniciar sesión.' using hint = 'unauthorized';
  end if;
  if me.must_change_password then
    raise exception 'Debes cambiar tu contraseña antes de continuar.';
  end if;
  return me;
end;
$$;

create or replace function private.load_absence(p_id bigint, me public.profiles)
returns public.absences
language plpgsql stable security definer set search_path = ''
as $$
declare
  a public.absences;
begin
  select * into a from public.absences where id = p_id and school_id = me.school_id;
  if a.id is null or (a.user_id <> me.id and me.role not in ('admin', 'director', 'secretary')) then
    raise exception 'No se encontró la ausencia.';
  end if;
  return a;
end;
$$;

create or replace function private.fmt_date(d date)
returns text
language sql immutable set search_path = ''
as $$
  select (array['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'])[extract(dow from d)::int + 1]
    || ' ' || extract(day from d)::int || ' '
    || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from d)::int]
$$;

create or replace function private.fmt_range(a date, b date)
returns text
language sql immutable set search_path = ''
as $$
  select case when a = b then private.fmt_date(a) else private.fmt_date(a) || ' – ' || private.fmt_date(b) end
$$;

create or replace function private.fmt_schedule(p_partial boolean, s time, e time)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when not p_partial then 'Día completo'
    when e is null then 'Desde ' || to_char(s, 'HH24:MI')
    else to_char(s, 'HH24:MI') || ' – ' || to_char(e, 'HH24:MI')
  end
$$;

create or replace function private.category_label(c text)
returns text
language sql immutable set search_path = ''
as $$
  select case c
    when 'enfermedad' then 'Enfermedad'
    when 'cita_medica' then 'Cita médica'
    when 'personal' then 'Asunto personal'
    when 'familiar' then 'Emergencia familiar'
    when 'oficial' then 'Capacitación / oficial'
    when 'otro' then 'Otro'
  end
$$;

create or replace function private.notify(p_users uuid[], p_title text, p_body text, p_link text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (user_id, title, body, link)
  select distinct u, p_title, p_body, p_link from unnest(p_users) as u where u is not null
$$;

create or replace function private.staff_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(id), '{}') from public.profiles
  where school_id = p_school and active and role in ('admin', 'director', 'secretary')
    and id is distinct from p_exclude
$$;

create or replace function private.clean_text(v text, max_len int, label text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  s text := nullif(btrim(v), '');
begin
  if s is not null and char_length(s) > max_len then
    raise exception '% es demasiado largo (máx. % caracteres).', label, max_len;
  end if;
  return s;
end;
$$;

-- Registers uploaded files (already in the "excuses" bucket) for an absence.
create or replace function private.insert_attachments(p_absence_id bigint, me public.profiles, p_files jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  f jsonb;
  v_path text;
  v_meta jsonb;
  n int := 0;
begin
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' then
    raise exception 'Archivos no válidos.';
  end if;
  if jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 5 then
    raise exception 'Puedes subir hasta 5 archivos a la vez.';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    v_path := f ->> 'path';
    if v_path is null or v_path not like me.school_id::text || '/' || me.id::text || '/%' then
      raise exception 'Archivo no válido.';
    end if;
    select o.metadata into v_meta from storage.objects o where o.bucket_id = 'excuses' and o.name = v_path;
    if not found then
      raise exception 'No se encontró el archivo subido. Inténtalo de nuevo.';
    end if;
    insert into public.attachments (absence_id, school_id, uploaded_by, uploaded_by_name, path, original_name, mime, size)
    values (
      p_absence_id, me.school_id, me.id, me.full_name, v_path,
      left(coalesce(nullif(btrim(f ->> 'name'), ''), 'archivo'), 200),
      coalesce(v_meta ->> 'mimetype', 'application/octet-stream'),
      coalesce((v_meta ->> 'size')::int, 0)
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Envío de avisos externos: notifications -> outbox -> pg_net -> Edge Function "notify"
-- ---------------------------------------------------------------------------

create or replace function private.queue_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.outbox (kind, payload) values ('push', jsonb_build_object('notification_id', new.id));
  return new;
end;
$$;

create trigger notifications_queue_push
after insert on public.notifications
for each row execute function private.queue_push();

create or replace function private.dispatch_outbox()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
begin
  select value ->> 'url' into v_url from public.app_settings where key = 'notify_url';
  if v_url is not null then
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 15000
    );
  end if;
  return new;
end;
$$;

create trigger outbox_dispatch
after insert on public.outbox
for each row execute function private.dispatch_outbox();

-- ---------------------------------------------------------------------------
-- Vistas
-- ---------------------------------------------------------------------------

create view public.absences_v with (security_invoker = true) as
select
  a.*,
  p.full_name as employee_name,
  p.position as employee_position,
  p.role as employee_role,
  (select count(*) from public.attachments t where t.absence_id = a.id)::int as attachment_count,
  (select count(*) from public.comments c where c.absence_id = a.id)::int as comment_count
from public.absences a
join public.profiles p on p.id = a.user_id;

create view public.employees_v with (security_invoker = true) as
select
  p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p.position,
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::int as absence_count
from public.profiles p
where p.role <> 'admin';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.schools enable row level security;
alter table public.school_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.absences enable row level security;
alter table public.attachments enable row level security;
alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_settings enable row level security;
alter table public.outbox enable row level security;

create policy "Ver mi escuela" on public.schools for select to authenticated
  using (id = (select private.my_school_id()));

create policy "Dirección ve la configuración" on public.school_settings for select to authenticated
  using (school_id = (select private.my_school_id()) and (select private.is_manager()));

create policy "Ver perfiles de mi escuela" on public.profiles for select to authenticated
  using (school_id = (select private.my_school_id()) and (id = (select auth.uid()) or (select private.is_staff())));

create policy "Ver ausencias" on public.absences for select to authenticated
  using (school_id = (select private.my_school_id()) and (user_id = (select auth.uid()) or (select private.is_staff())));

create policy "Ver documentos" on public.attachments for select to authenticated
  using (exists (select 1 from public.absences a where a.id = absence_id));

create policy "Ver comentarios" on public.comments for select to authenticated
  using (exists (select 1 from public.absences a where a.id = absence_id));

create policy "Ver mis avisos" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Ver mis suscripciones" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- Nobody but the server touches app_settings/outbox; writes elsewhere go through the RPCs below.
revoke all on public.app_settings, public.outbox from anon, authenticated;
revoke insert, update, delete, truncate on
  public.schools, public.school_settings, public.profiles, public.absences, public.attachments,
  public.comments, public.notifications, public.push_subscriptions
  from anon, authenticated;
revoke all on
  public.schools, public.school_settings, public.profiles, public.absences, public.attachments,
  public.comments, public.notifications, public.push_subscriptions, public.absences_v, public.employees_v
  from anon;

-- ---------------------------------------------------------------------------
-- Archivos de excusas (Storage)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'excuses', 'excuses', false, 10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- Uploads go to {school_id}/{user_id}/..., so each person can only write into their own folder.
create policy "Subir excusas a mi carpeta" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'excuses'
    and (storage.foldername(name))[1] = (select private.my_school_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "Ver excusas permitidas" on storage.objects for select to authenticated
  using (
    bucket_id = 'excuses'
    and (
      ((storage.foldername(name))[1] = (select private.my_school_id())::text
        and (storage.foldername(name))[2] = (select auth.uid())::text)
      or exists (select 1 from public.attachments t where t.path = objects.name)
    )
  );

create policy "Borrar excusas" on storage.objects for delete to authenticated
  using (
    bucket_id = 'excuses'
    and (storage.foldername(name))[1] = (select private.my_school_id())::text
    and ((storage.foldername(name))[2] = (select auth.uid())::text or (select private.is_manager()))
  );

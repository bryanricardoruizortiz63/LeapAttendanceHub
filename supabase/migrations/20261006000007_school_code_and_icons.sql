-- 1) The school's Administración account can change the school code (the "admin" Edge Function moves
--    every login to the new code). Old codes are kept here so links and phones that still have the old
--    code keep working, and so no other school can take a code that was already in use.
-- 2) Each school can have its own app icon, uploaded from the platform panel to the public "branding"
--    bucket ({school_id}/icon-192.png …). schools.icon_version is null for the default icon.

create table public.school_code_history (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  school_id uuid not null references public.schools on delete cascade,
  changed_at timestamptz not null default now()
);
create index school_code_history_school on public.school_code_history (school_id);

alter table public.school_code_history enable row level security;
revoke all on public.school_code_history from anon, authenticated;

-- An active school by its current code, or by a code it used before.
create or replace function private.resolve_school(p_code text)
returns public.schools
language sql stable security definer set search_path = ''
as $$
  select s.* from public.schools s
  where s.active
    and (s.code = upper(btrim(p_code))
      or s.id = (select h.school_id from public.school_code_history h where h.code = upper(btrim(p_code))))
  order by (s.code = upper(btrim(p_code))) desc
  limit 1
$$;

-- For the login screen: when someone types an old code, the school's current one (null otherwise).
create or replace function public.current_school_code(p_code text)
returns text
language sql stable security definer set search_path = ''
as $$
  select s.code
  from public.school_code_history h
  join public.schools s on s.id = h.school_id
  where h.code = upper(btrim(p_code)) and s.active
    and not exists (select 1 from public.schools x where x.code = upper(btrim(p_code)))
$$;

-- Same as before, but an old school code still works.
create or replace function public.request_password_help(p_school_code text, p_username text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.schools := private.resolve_school(p_school_code);
  p public.profiles;
begin
  if s.id is null then
    return;
  end if;
  select * into p from public.profiles
  where school_id = s.id and username = lower(btrim(p_username)) and active and role <> 'admin';
  if p.id is null or (p.password_help_at is not null and p.password_help_at > now() - interval '15 minutes') then
    return;
  end if;

  update public.profiles set password_help_at = now() where id = p.id;
  perform private.notify(
    private.manager_ids(s.id, p.id),
    'Olvidó su contraseña: ' || p.full_name,
    'Usuario: ' || p.username || '. Toca para darle una contraseña temporal.',
    '#/employees/' || p.id
  );
  insert into public.outbox (kind, school_id, payload)
  values ('teams', s.id, jsonb_build_object('event', 'password_help', 'user_id', p.id));
end;
$$;

revoke execute on function private.resolve_school(text) from public, anon, authenticated;
revoke execute on function public.current_school_code(text) from public;
grant execute on function public.current_school_code(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Per-school icon
-- ---------------------------------------------------------------------------

alter table public.schools add column if not exists icon_version bigint;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 1048576, array['image/png'])
on conflict (id) do nothing;

-- Same as before, plus the school's icon version.
create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password
    ),
    'school', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'icon_version', s.icon_version)
  )
  from public.profiles p
  join public.schools s on s.id = p.school_id
  where p.id = auth.uid() and p.active and s.active
$$;

-- For the login screen: which icon to show for a school code (current or old). Null if unknown.
create or replace function public.school_branding(p_code text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when s.id is null then null else jsonb_build_object('school_id', s.id, 'icon_version', s.icon_version) end
  from private.resolve_school(p_code) s
$$;

create or replace function public.platform_schools()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb) from (
    select s.id, s.code, s.name, s.active, s.created_at, s.icon_version,
      (ss.teams_webhook_url is not null) as has_teams,
      (select count(*) from public.profiles p where p.school_id = s.id and p.role <> 'admin' and p.active) as employees,
      (select count(*) from public.absences a where a.school_id = s.id) as absences,
      (select max(a.created_at) from public.absences a where a.school_id = s.id) as last_absence_at
    from public.schools s
    left join public.school_settings ss on ss.school_id = s.id
  ) x
$$;

revoke execute on function public.school_branding(text) from public;
grant execute on function public.school_branding(text) to anon, authenticated;

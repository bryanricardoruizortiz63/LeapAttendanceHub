-- Common base for the next modules (turns, alerts, reservations):
--   * the school calendar: class hours, school days and the days without classes;
--   * the school's grades and groups (9-B, 10-A…) and the groups each person teaches;
--   * each person's room (salón), which they can change themselves.
-- New permission:
--   calendar  class hours, days without classes and the list of grades and groups.
--             Given to Administración, Secretaría and every role that could configure the school.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar']::text[]);

update public.school_roles set permissions = permissions || 'calendar'::text
where not 'calendar' = any(permissions) and (key in ('admin', 'secretary') or 'settings' = any(permissions));

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'calendar'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'mantenimiento', 'Mantenimiento', '{}', false, false, 60),
    (p_school, 'seguridad', 'Seguridad', '{}', false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Class hours, school days and grades and groups
-- ---------------------------------------------------------------------------

alter table public.school_settings
  add column day_start time not null default '07:40',
  add column day_end time not null default '15:30',
  -- ISO weekdays: 1 = Monday … 7 = Sunday.
  add column school_days smallint[] not null default '{1,2,3,4,5}',
  -- The school's grades and groups, in display order (e.g. K-A, 1-A … 12-C).
  add column groups text[] not null default '{}',
  add constraint school_settings_hours_check check (day_end > day_start),
  add constraint school_settings_days_check
    check (school_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(school_days) between 1 and 7),
  add constraint school_settings_groups_check check (cardinality(groups) <= 200);

-- Days without classes. holiday: nobody works · no_classes: no students, the staff works (e.g. training).
create table public.school_closures (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  start_date date not null,
  end_date date not null,
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  kind text not null default 'holiday' check (kind in ('holiday', 'no_classes')),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366)
);
create index school_closures_school on public.school_closures (school_id, end_date);

alter table public.school_closures enable row level security;
create policy "Ver el calendario de mi escuela" on public.school_closures for select to authenticated
  using (school_id = (select private.my_school_id()));
revoke insert, update, delete, truncate on public.school_closures from anon, authenticated;
revoke all on public.school_closures from anon;

-- ---------------------------------------------------------------------------
-- Each person's room and groups
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column room text check (char_length(room) <= 40),
  add column groups text[] not null default '{}' check (cardinality(groups) <= 50);

/** A person's groups must be groups of their school (the admin function sends the exact names). */
create or replace function private.check_profile_groups()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_school text[];
  v_missing text;
begin
  if cardinality(new.groups) = 0 then return new; end if;
  select s.groups into v_school from public.school_settings s where s.school_id = new.school_id;
  select g into v_missing from unnest(new.groups) g where not g = any(coalesce(v_school, '{}')) limit 1;
  if v_missing is not null then
    raise exception 'El grupo «%» no existe. Créalo primero en Calendario escolar.', v_missing;
  end if;
  -- No repeats, in the school's order.
  new.groups := array(select g from unnest(v_school) with ordinality as t(g, n) where g = any(new.groups) order by n);
  return new;
end;
$$;

create trigger profiles_check_groups before insert or update of groups on public.profiles
  for each row execute function private.check_profile_groups();

create or replace view public.employees_v with (security_invoker = true) as
  select p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p.position,
    p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
    (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::int as absence_count,
    p.password_help_at, p.room, p.groups
  from public.profiles p
  where p.role <> 'admin';

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

create or replace function private.require_calendar()
returns public.profiles
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'calendar') then
    raise exception 'No tienes permiso para cambiar el calendario escolar.';
  end if;
  return me;
end;
$$;

/** "9 - b " → "9 - b" (spaces trimmed and collapsed); null when empty. */
create or replace function private.clean_group(p_name text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  s text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
begin
  if s is not null and char_length(s) > 20 then
    raise exception 'El grupo «%» es demasiado largo (máx. 20 caracteres).', s;
  end if;
  return s;
end;
$$;

/** Natural order: K-A, Kinder, 1-A, 2-B … 10-A, 12-C (names starting with a number by that number). */
create or replace function private.sort_groups(p_groups text[])
returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(g order by coalesce(substring(g from '^\d+')::numeric, -1), lower(g), g), '{}')
  from unnest(p_groups) g
$$;

create or replace function private.calendar_json(p_school uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'day_start', to_char(coalesce(s.day_start, '07:40'), 'HH24:MI'),
    'day_end', to_char(coalesce(s.day_end, '15:30'), 'HH24:MI'),
    'school_days', to_jsonb(coalesce(s.school_days, '{1,2,3,4,5}')),
    'groups', to_jsonb(coalesce(s.groups, '{}'))
  )
  from (select 1) x
  left join public.school_settings s on s.school_id = p_school
$$;

create or replace function public.save_school_hours(p_day_start time, p_day_end time, p_school_days int[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
  v_days smallint[];
begin
  if p_day_start is null or p_day_end is null then raise exception 'Indica la hora de entrada y la de salida.'; end if;
  if p_day_end <= p_day_start then raise exception 'La hora de salida debe ser después de la de entrada.'; end if;
  if exists (select 1 from unnest(p_school_days) d where d not between 1 and 7) then raise exception 'Día no válido.'; end if;
  select array_agg(distinct d::smallint order by d::smallint) into v_days from unnest(p_school_days) d where d is not null;
  if v_days is null then raise exception 'Elige al menos un día de clases.'; end if;
  insert into public.school_settings (school_id, day_start, day_end, school_days)
  values (me.school_id, p_day_start, p_day_end, v_days)
  on conflict (school_id) do update
    set day_start = excluded.day_start, day_end = excluded.day_end, school_days = excluded.school_days;
  return private.calendar_json(me.school_id);
end;
$$;

/** Adds (p_id null) or changes a day or period without classes. */
create or replace function public.save_closure(p_id bigint, p_start date, p_end date, p_name text, p_kind text)
returns public.school_closures
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
  v_name text := private.clean_text(p_name, 80, 'El nombre');
  v_end date := coalesce(p_end, p_start);
  v_kind text := coalesce(nullif(p_kind, ''), 'holiday');
  r public.school_closures;
begin
  if p_start is null then raise exception 'Elige la fecha.'; end if;
  if v_name is null then raise exception 'Escribe el nombre (por ejemplo, «Día de Acción de Gracias»).'; end if;
  if v_end < p_start then raise exception 'La fecha final debe ser igual o después de la inicial.'; end if;
  if v_end - p_start > 366 then raise exception 'El período no puede ser de más de un año.'; end if;
  if p_start < current_date - 730 or v_end > current_date + 730 then
    raise exception 'Elige una fecha dentro de los próximos dos años.';
  end if;
  if v_kind not in ('holiday', 'no_classes') then raise exception 'Tipo de día no válido.'; end if;
  if p_id is null then
    insert into public.school_closures (school_id, start_date, end_date, name, kind, created_by)
    values (me.school_id, p_start, v_end, v_name, v_kind, me.id)
    returning * into r;
  else
    update public.school_closures
    set start_date = p_start, end_date = v_end, name = v_name, kind = v_kind
    where id = p_id and school_id = me.school_id
    returning * into r;
    if r.id is null then raise exception 'No se encontró ese día en el calendario.'; end if;
  end if;
  return r;
end;
$$;

create or replace function public.add_school_groups(p_names text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
  v_groups text[];
  v_name text;
begin
  select s.groups into v_groups from public.school_settings s where s.school_id = me.school_id for update;
  v_groups := coalesce(v_groups, '{}');
  foreach v_name in array coalesce(p_names, '{}') loop
    v_name := private.clean_group(v_name);
    if v_name is not null and not exists (select 1 from unnest(v_groups) g where lower(g) = lower(v_name)) then
      v_groups := v_groups || v_name;
    end if;
  end loop;
  if cardinality(v_groups) > 200 then raise exception 'La escuela puede tener hasta 200 grupos.'; end if;
  v_groups := private.sort_groups(v_groups);
  insert into public.school_settings (school_id, groups) values (me.school_id, v_groups)
  on conflict (school_id) do update set groups = excluded.groups;
  return v_groups;
end;
$$;

/** The people in the group keep it under its new name. */
create or replace function public.rename_school_group(p_old text, p_new text)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
  v_groups text[];
  v_new text := private.clean_group(p_new);
begin
  select s.groups into v_groups from public.school_settings s where s.school_id = me.school_id for update;
  if not p_old = any(coalesce(v_groups, '{}')) then raise exception 'No se encontró el grupo «%».', p_old; end if;
  if v_new is null then raise exception 'Escribe el nombre del grupo.'; end if;
  if v_new = p_old then return v_groups; end if;
  if exists (select 1 from unnest(v_groups) g where lower(g) = lower(v_new) and g <> p_old) then
    raise exception 'Ya existe el grupo «%».', v_new;
  end if;
  v_groups := private.sort_groups(array_replace(v_groups, p_old, v_new));
  update public.school_settings set groups = v_groups where school_id = me.school_id;
  update public.profiles set groups = array_replace(groups, p_old, v_new)
  where school_id = me.school_id and p_old = any(groups);
  return v_groups;
end;
$$;

/** Also removed from the people who had it. */
create or replace function public.remove_school_group(p_name text)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_calendar();
  v_groups text[];
begin
  select s.groups into v_groups from public.school_settings s where s.school_id = me.school_id for update;
  if not p_name = any(coalesce(v_groups, '{}')) then raise exception 'No se encontró el grupo «%».', p_name; end if;
  v_groups := array_remove(v_groups, p_name);
  update public.school_settings set groups = v_groups where school_id = me.school_id;
  update public.profiles set groups = array_remove(groups, p_name)
  where school_id = me.school_id and p_name = any(groups);
  return v_groups;
end;
$$;

/** Everyone can set the room where they usually are. */
create or replace function public.set_my_room(p_room text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_room text := private.clean_text(regexp_replace(coalesce(p_room, ''), '\s+', ' ', 'g'), 40, 'El salón');
begin
  update public.profiles set room = v_room, updated_at = now() where id = me.id;
  return v_room;
end;
$$;

-- Same as before, plus my room and groups and the school calendar.
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
      'coverage', coalesce(r.coverage and p.role <> 'admin', false),
      'room', p.room, 'groups', to_jsonb(p.groups)
    ),
    'school', jsonb_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'icon_version', s.icon_version,
      'calendar', private.calendar_json(s.id)
    ),
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

revoke execute on function
  private.check_profile_groups(), private.require_calendar(), private.clean_group(text),
  private.sort_groups(text[]), private.calendar_json(uuid)
  from public, anon, authenticated;
revoke execute on function
  public.save_school_hours(time, time, int[]),
  public.save_closure(bigint, date, date, text, text),
  public.add_school_groups(text[]),
  public.rename_school_group(text, text),
  public.remove_school_group(text),
  public.set_my_room(text)
  from public, anon;
grant execute on function
  public.save_school_hours(time, time, int[]),
  public.save_closure(bigint, date, date, text, text),
  public.add_school_groups(text[]),
  public.rename_school_group(text, text),
  public.remove_school_group(text),
  public.set_my_room(text)
  to authenticated;

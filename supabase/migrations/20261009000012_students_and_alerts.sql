-- Alerts in the hallway:
--   * "No ha llegado": a student who should have arrived didn't. The teacher warns Seguridad (which includes the
--     dirección and the secretaría) or the whole staff; whoever finds the student marks "Apareció".
--   * Salidas (pickups): the teacher says someone will pick up a student; when the parent arrives, the teacher or
--     Seguridad says so, Seguridad goes to the room and hands the student over.
--   * Relevo: a teacher asks someone to cover the room for a moment; the first who taps "Yo lo relevo" goes.
-- Students: there is no student list. Only the students a teacher notes for one of these are kept, for 24 hours,
-- so that the next teacher can follow them. Writing a name like one noted in the same group asks
-- "¿Es José Pérez Rivera (9-B)?" first.
-- New permission:
--   security  receives the "No ha llegado" alerts sent to Seguridad and handles the pickups.
--             Given to Seguridad, Secretaría, Administración and every role that could configure the school.
-- Urgent notices are pushed again every minute (for up to 15 minutes) until the person opens them or someone
-- takes care of it. The hourly purge (notify Edge Function) deletes the students after 24 hours and the alert
-- notices that named them.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security']::text[]);

update public.school_roles set permissions = permissions || 'security'::text
where not 'security' = any(permissions) and (key in ('admin', 'secretary', 'seguridad') or 'settings' = any(permissions));

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'calendar', 'security'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'mantenimiento', 'Mantenimiento', '{}', false, false, 60),
    (p_school, 'seguridad', 'Seguridad', array['security'], false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Urgent notifications
-- ---------------------------------------------------------------------------

-- tag: notices about the same thing replace each other on the phone · urgent: alarm until opened.
alter table public.notifications
  add column tag text check (char_length(tag) <= 60),
  add column urgent boolean not null default false;

create index notifications_urgent on public.notifications (created_at) where urgent and read_at is null;
create index notifications_link on public.notifications (link) where read_at is null;

alter table public.outbox drop constraint if exists outbox_kind_check;
alter table public.outbox add constraint outbox_kind_check check (kind in ('push', 'teams', 'maintenance', 'purge'));

create or replace function private.notify_tagged(p_users uuid[], p_title text, p_body text, p_link text, p_tag text, p_urgent boolean)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notifications (user_id, title, body, link, tag, urgent)
  select distinct u, p_title, p_body, p_link, p_tag, p_urgent from unnest(p_users) as u where u is not null
$$;

/** Someone took care of it: nobody gets the earlier notices again. */
create or replace function private.close_notifications(p_link text)
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set read_at = now() where link = p_link and read_at is null
$$;

/** Every minute (pg_cron): push again the urgent notices nobody has opened yet, for up to 15 minutes. */
create or replace function private.repeat_urgent()
returns void
language sql security definer set search_path = ''
as $$
  insert into public.outbox (kind, payload)
  select 'push', jsonb_build_object('notification_id', n.id, 'repeat', true)
  from public.notifications n
  where n.urgent and n.read_at is null
    and n.created_at > now() - interval '15 minutes'
    and n.created_at < now() - interval '50 seconds'
$$;

/** Opening the alerts (or one of them) stops its repeats for me. */
create or replace function public.mark_alerts_read(p_link text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  update public.notifications set read_at = now()
  where user_id = me.id and read_at is null
    and (case when p_link is null then link like '#/alerts/%' else link = p_link end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Who is told
-- ---------------------------------------------------------------------------

/** Active people of the school whose role has the permission (Administración has them all). */
create or replace function private.perm_ids(p_school uuid, p_perm text, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.school_id = p_school and p.active and p_perm = any(r.permissions) and p.id is distinct from p_exclude
$$;

create or replace function private.all_staff_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  where p.school_id = p_school and p.active and p.id is distinct from p_exclude
$$;

-- Relief requests go to the teachers (roles whose absences need coverage) and to the dirección and the
-- secretaría (they see everyone's absences); not to Seguridad, Enfermería or Mantenimiento.
create or replace function private.relief_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.school_id = p_school and p.active and (r.coverage or 'absences' = any(r.permissions))
    and p.id is distinct from p_exclude
$$;

create or replace function private.in_relief_audience()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    join public.school_roles r on r.school_id = p.school_id and r.key = p.role
    where p.id = auth.uid() and p.active and (r.coverage or 'absences' = any(r.permissions))
  )
$$;

/** 13:05 → "1:05 p. m." */
create or replace function private.time_text(p_time time)
returns text
language sql immutable set search_path = ''
as $$
  select to_char(p_time, 'FMHH12:MI') || case when p_time < '12:00' then ' a. m.' else ' p. m.' end
$$;

-- ---------------------------------------------------------------------------
-- Students noted for an alert or a pickup (kept 24 hours)
-- ---------------------------------------------------------------------------

create table public.students (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  name text not null check (char_length(name) between 2 and 100 and name = btrim(name)),
  -- For matching: lower case, no accents, only letters and numbers.
  name_key text not null,
  group_name text not null check (char_length(group_name) between 1 and 20),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index students_school_group on public.students (school_id, group_name, expires_at);
create index students_expires on public.students (expires_at);

/** "José  Pérez-Rivera" → "jose perez rivera". */
create or replace function private.student_key(p_name text)
returns text
language sql immutable set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_name, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

/** The group as the school writes it (case doesn't matter). Free text when the school has no groups yet. */
create or replace function private.school_group(p_school uuid, p_group text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_group text := nullif(regexp_replace(btrim(coalesce(p_group, '')), '\s+', ' ', 'g'), '');
  v_groups text[];
  v_found text;
begin
  if v_group is null then raise exception 'Elige el grado y grupo del estudiante.'; end if;
  if char_length(v_group) > 20 then raise exception 'El grupo es demasiado largo (máx. 20 caracteres).'; end if;
  select s.groups into v_groups from public.school_settings s where s.school_id = p_school;
  if cardinality(coalesce(v_groups, '{}')) = 0 then return v_group; end if;
  select g into v_found from unnest(v_groups) g where lower(g) = lower(v_group) limit 1;
  if v_found is null then raise exception 'El grupo «%» no existe en la escuela.', v_group; end if;
  return v_found;
end;
$$;

/** The student for an alert or a pickup: the one chosen, the same name in the same group, or a new one. */
create or replace function private.note_student(me public.profiles, p_student_id bigint, p_name text, p_group text)
returns public.students
language plpgsql security definer set search_path = ''
as $$
declare
  s public.students;
  v_name text;
  v_group text;
begin
  if p_student_id is not null then
    update public.students set expires_at = now() + interval '24 hours'
    where id = p_student_id and school_id = me.school_id and expires_at > now()
    returning * into s;
    if s.id is null then raise exception 'Ese estudiante ya no está en la lista de hoy. Escribe su nombre de nuevo.'; end if;
    return s;
  end if;
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if char_length(v_name) < 2 then raise exception 'Escribe el nombre del estudiante.'; end if;
  if char_length(v_name) > 100 then raise exception 'El nombre es demasiado largo (máx. 100 caracteres).'; end if;
  v_group := private.school_group(me.school_id, p_group);
  update public.students set expires_at = now() + interval '24 hours'
  where id = (
    select x.id from public.students x
    where x.school_id = me.school_id and x.group_name = v_group and x.name_key = private.student_key(v_name)
      and x.expires_at > now()
    order by x.id desc limit 1
  )
  returning * into s;
  if s.id is null then
    insert into public.students (school_id, name, name_key, group_name, created_by)
    values (me.school_id, v_name, private.student_key(v_name), v_group, me.id)
    returning * into s;
  end if;
  return s;
end;
$$;

/**
 * Students noted today in the same group with a name like this one, to ask "¿Es el mismo?" before noting a new
 * one. exact = same name. Only names similar to what was typed, in the group that was chosen.
 */
create or replace function public.similar_students(p_name text, p_group text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_key text := private.student_key(p_name);
  v_group text := private.school_group(me.school_id, p_group);
begin
  if char_length(v_key) < 2 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'group_name', x.group_name, 'exact', x.name_key = v_key)
      order by x.name_key = v_key desc, extensions.similarity(x.name_key, v_key) desc)
    from (
      select s.* from public.students s
      where s.school_id = me.school_id and s.group_name = v_group and s.expires_at > now()
        and (s.name_key = v_key
          or extensions.similarity(s.name_key, v_key) >= 0.35
          or s.name_key like v_key || ' %' or v_key like s.name_key || ' %')
      order by s.name_key = v_key desc, extensions.similarity(s.name_key, v_key) desc
      limit 5
    ) x
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- "No ha llegado"
-- ---------------------------------------------------------------------------

create table public.student_alerts (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  student_id bigint references public.students on delete set null,
  group_name text not null,
  -- Where the student was coming from or going to, and where they should have arrived.
  place text check (char_length(place) <= 120),
  room text check (char_length(room) <= 40),
  note text check (char_length(note) <= 500),
  -- security: Seguridad, dirección and secretaría (permission "security") · all: the whole staff.
  audience text not null check (audience in ('security', 'all')),
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles on delete set null,
  resolved_by_name text,
  found_place text check (char_length(found_place) <= 120)
);
create index student_alerts_school on public.student_alerts (school_id, created_at desc);
create index student_alerts_student on public.student_alerts (student_id);

-- ---------------------------------------------------------------------------
-- Salidas (pickups)
-- ---------------------------------------------------------------------------

create table public.student_pickups (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  student_id bigint references public.students on delete set null,
  group_name text not null,
  room text check (char_length(room) <= 40),
  expected_time time,
  note text check (char_length(note) <= 300),
  -- scheduled → arrived (the parent is here) → on_the_way (Seguridad goes to the room) → delivered
  status text not null default 'scheduled' check (status in ('scheduled', 'arrived', 'on_the_way', 'delivered', 'cancelled')),
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  arrived_at timestamptz,
  arrived_by_name text,
  on_the_way_at timestamptz,
  on_the_way_by_name text,
  delivered_at timestamptz,
  delivered_by_name text,
  picked_up_by text check (char_length(picked_up_by) <= 120),
  cancelled_at timestamptz,
  cancelled_by_name text
);
create index student_pickups_school on public.student_pickups (school_id, created_at desc);
create index student_pickups_student on public.student_pickups (student_id);

-- ---------------------------------------------------------------------------
-- Relevo
-- ---------------------------------------------------------------------------

create table public.relief_requests (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  requested_by uuid references public.profiles on delete set null,
  requested_by_name text not null,
  room text check (char_length(room) <= 40),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  taken_by uuid references public.profiles on delete set null,
  taken_by_name text,
  cancelled_at timestamptz
);
create index relief_requests_school on public.relief_requests (school_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Who sees what
-- ---------------------------------------------------------------------------

/** A noted student's name: whoever noted them, Seguridad and the dirección, their group's teachers, and whoever
 *  got an alert about them or noted an alert or a pickup for them. */
create or replace function private.can_see_student(p_id bigint, p_group text, p_created_by uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_created_by = auth.uid()
    or private.has_perm('security') or private.has_perm('absences')
    or p_group = any(coalesce((select p.groups from public.profiles p where p.id = auth.uid()), '{}'))
    or exists (select 1 from public.student_alerts a where a.student_id = p_id and (a.audience = 'all' or a.created_by = auth.uid()))
    or exists (select 1 from public.student_pickups k where k.student_id = p_id and k.created_by = auth.uid())
$$;

alter table public.students enable row level security;
create policy "Ver estudiantes apuntados" on public.students for select to authenticated
  using (school_id = (select private.my_school_id()) and expires_at > now() and private.can_see_student(id, group_name, created_by));

alter table public.student_alerts enable row level security;
create policy "Ver alertas de estudiantes" on public.student_alerts for select to authenticated
  using (school_id = (select private.my_school_id())
    and (created_by = (select auth.uid()) or audience = 'all' or (select private.has_perm('security'))));

alter table public.student_pickups enable row level security;
create policy "Ver salidas" on public.student_pickups for select to authenticated
  using (school_id = (select private.my_school_id())
    and (created_by = (select auth.uid()) or (select private.has_perm('security'))
      or group_name = any(coalesce((select p.groups from public.profiles p where p.id = (select auth.uid())), '{}'))));

alter table public.relief_requests enable row level security;
create policy "Ver relevos" on public.relief_requests for select to authenticated
  using (school_id = (select private.my_school_id())
    and (requested_by = (select auth.uid()) or (select private.in_relief_audience())));

revoke insert, update, delete, truncate on public.students, public.student_alerts, public.student_pickups, public.relief_requests
  from anon, authenticated;
revoke all on public.students, public.student_alerts, public.student_pickups, public.relief_requests from anon;

-- The student's name comes from students (and disappears with it after 24 hours).
create view public.student_alerts_v with (security_invoker = true) as
  select a.*, s.name as student_name from public.student_alerts a left join public.students s on s.id = a.student_id;
create view public.student_pickups_v with (security_invoker = true) as
  select k.*, s.name as student_name from public.student_pickups k left join public.students s on s.id = k.student_id;

-- ---------------------------------------------------------------------------
-- RPC: "No ha llegado"
-- ---------------------------------------------------------------------------

create or replace function public.create_student_alert(
  p_student_id bigint, p_name text, p_group text, p_place text, p_room text, p_note text, p_audience text
)
returns public.student_alerts
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.students;
  a public.student_alerts;
  v_audience text := coalesce(nullif(p_audience, ''), 'security');
  v_place text := private.clean_text(p_place, 120, 'El lugar');
  v_room text := private.clean_text(p_room, 40, 'El salón');
  v_link text;
begin
  if v_audience not in ('security', 'all') then raise exception 'Elige a quién avisar.'; end if;
  if (select count(*) from public.student_alerts x where x.created_by = me.id and x.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Enviaste muchas alertas en la última hora. Llama a la oficina.';
  end if;
  s := private.note_student(me, p_student_id, p_name, p_group);
  select * into a from public.student_alerts x where x.student_id = s.id and x.resolved_at is null limit 1;
  if a.id is not null then
    raise exception 'Ya hay una alerta abierta para % (%), enviada por %.', s.name, s.group_name, a.created_by_name;
  end if;
  insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name)
  values (me.school_id, s.id, s.group_name, v_place, v_room, private.clean_text(p_note, 500, 'La nota'), v_audience, me.id, me.full_name)
  returning * into a;
  v_link := '#/alerts/missing/' || a.id;
  perform private.notify_tagged(
    case when v_audience = 'all' then private.all_staff_ids(me.school_id, me.id) else private.perm_ids(me.school_id, 'security', me.id) end,
    format('🚨 No ha llegado: %s (%s)', s.name, s.group_name),
    concat_ws(' · ', 'Debía llegar al salón ' || v_room, v_place, 'avisó ' || me.full_name) || '. Si lo ves, toca «Apareció».',
    v_link, 'missing-' || a.id, true);
  return a;
end;
$$;

/** Whoever finds the student (or the teacher, when the student arrives) closes the alert. */
create or replace function public.resolve_student_alert(p_id bigint, p_found_place text)
returns public.student_alerts
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.student_alerts;
  v_name text;
  v_found text := private.clean_text(p_found_place, 120, 'El lugar');
  v_link text := '#/alerts/missing/' || p_id;
begin
  select * into a from public.student_alerts x
  where x.id = p_id and x.school_id = me.school_id
    and (x.created_by = me.id or x.audience = 'all' or private.can(me, 'security'))
  for update;
  if a.id is null then raise exception 'No se encontró la alerta.'; end if;
  if a.resolved_at is not null then
    raise exception 'Esta alerta ya se cerró: la cerró %.', coalesce(a.resolved_by_name, 'otra persona');
  end if;
  update public.student_alerts
  set resolved_at = now(), resolved_by = me.id, resolved_by_name = me.full_name, found_place = v_found
  where id = a.id
  returning * into a;
  select s.name into v_name from public.students s where s.id = a.student_id;
  perform private.close_notifications(v_link);
  perform private.notify_tagged(
    array_append(
      case when a.audience = 'all' then private.all_staff_ids(me.school_id, me.id) else private.perm_ids(me.school_id, 'security', me.id) end,
      case when a.created_by is distinct from me.id then a.created_by end),
    format('✅ Apareció: %s (%s)', coalesce(v_name, 'estudiante'), a.group_name),
    concat_ws(' · ', 'Estaba: ' || v_found, 'lo confirmó ' || me.full_name) || '.',
    v_link, 'missing-' || a.id, false);
  return a;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: Salidas
-- ---------------------------------------------------------------------------

create or replace function public.create_pickup(
  p_student_id bigint, p_name text, p_group text, p_time time, p_room text, p_note text
)
returns public.student_pickups
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.students;
  k public.student_pickups;
  v_room text := private.clean_text(p_room, 40, 'El salón');
  v_note text := private.clean_text(p_note, 300, 'La nota');
begin
  if (select count(*) from public.student_pickups x where x.created_by = me.id and x.created_at > now() - interval '1 day') >= 40 then
    raise exception 'Llegaste al máximo de salidas de hoy.';
  end if;
  s := private.note_student(me, p_student_id, p_name, p_group);
  select * into k from public.student_pickups x
  where x.student_id = s.id and x.status not in ('delivered', 'cancelled') limit 1;
  if k.id is not null then
    raise exception 'Ya hay una salida anotada para % (%), de %.', s.name, s.group_name, k.created_by_name;
  end if;
  insert into public.student_pickups (school_id, student_id, group_name, room, expected_time, note, created_by, created_by_name)
  values (me.school_id, s.id, s.group_name, v_room, p_time, v_note, me.id, me.full_name)
  returning * into k;
  perform private.notify_tagged(
    private.perm_ids(me.school_id, 'security', me.id),
    format('🚗 Salida: %s (%s)', s.name, s.group_name),
    concat_ws(' · ',
      'Lo vienen a buscar' || coalesce(' a las ' || private.time_text(p_time), ''),
      'salón ' || v_room,
      v_note,
      'avisó ' || me.full_name) || '.',
    '#/alerts/pickup/' || k.id, 'pickup-' || k.id, false);
  return k;
end;
$$;

/**
 * The next step of a pickup. arrived: the teacher (or a teacher of the group) or Seguridad · on_the_way and
 * delivered: Seguridad · cancelled: whoever noted it or Seguridad. p_picked_up_by: who took the student (optional).
 */
create or replace function public.advance_pickup(p_id bigint, p_step text, p_picked_up_by text default null)
returns public.student_pickups
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  k public.student_pickups;
  v_name text;
  v_security boolean := private.can(me, 'security');
  v_teacher boolean;
  v_link text := '#/alerts/pickup/' || p_id;
  v_tag text := 'pickup-' || p_id;
  v_who text;
  v_room text;
  v_to_room text;
begin
  select * into k from public.student_pickups x where x.id = p_id and x.school_id = me.school_id for update;
  if k.id is null then raise exception 'No se encontró la salida.'; end if;
  v_teacher := k.created_by = me.id or k.group_name = any(me.groups);
  if not (v_security or v_teacher) then raise exception 'No se encontró la salida.'; end if;
  if k.status in ('delivered', 'cancelled') then
    raise exception 'Esta salida ya terminó (%).', case k.status when 'delivered' then 'entregado' else 'cancelada' end;
  end if;
  select s.name into v_name from public.students s where s.id = k.student_id;
  v_who := format('%s (%s)', coalesce(v_name, 'estudiante'), k.group_name);
  v_room := coalesce('el salón ' || k.room, 'el salón');
  v_to_room := coalesce('al salón ' || k.room, 'al salón');

  if p_step = 'arrived' then
    if k.status <> 'scheduled' then raise exception 'Ya se avisó que llegó el encargado.'; end if;
    update public.student_pickups set status = 'arrived', arrived_at = now(), arrived_by_name = me.full_name
    where id = k.id returning * into k;
    perform private.close_notifications(v_link);
    if v_security then
      -- Seguridad saw the parent: the teacher gets the student ready.
      perform private.notify_tagged(array_remove(array[k.created_by], me.id),
        format('🚗 Llegó el encargado de %s', v_who),
        format('Prepáralo: Seguridad pasa a buscarlo %s.', v_to_room), v_link, v_tag, true);
    else
      -- The teacher knows the parent is here: Seguridad goes to the room.
      perform private.notify_tagged(private.perm_ids(me.school_id, 'security', me.id),
        format('🚗 Llegó el encargado de %s', v_who),
        format('Pasa por %s a buscarlo · avisó %s.', v_room, me.full_name), v_link, v_tag, true);
    end if;
  elsif p_step = 'on_the_way' then
    if not v_security then raise exception 'Solo Seguridad marca que va al salón.'; end if;
    if k.status not in ('scheduled', 'arrived') then raise exception 'Ya alguien va al salón.'; end if;
    update public.student_pickups set status = 'on_the_way', on_the_way_at = now(), on_the_way_by_name = me.full_name,
      arrived_at = coalesce(arrived_at, now()), arrived_by_name = coalesce(arrived_by_name, me.full_name)
    where id = k.id returning * into k;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(array_remove(array[k.created_by], me.id),
      format('🚶 %s va %s por %s', me.full_name, v_to_room, v_who), 'Tenlo listo para salir.', v_link, v_tag, false);
    -- The rest of Seguridad: someone is already going.
    perform private.notify_tagged(array_remove(private.perm_ids(me.school_id, 'security', me.id), k.created_by),
      format('🚶 %s ya va por %s', me.full_name, v_who), 'No hace falta que vaya nadie más.', v_link, v_tag, false);
  elsif p_step = 'delivered' then
    if not v_security then raise exception 'Solo Seguridad marca la entrega.'; end if;
    update public.student_pickups set status = 'delivered', delivered_at = now(), delivered_by_name = me.full_name,
      picked_up_by = private.clean_text(p_picked_up_by, 120, 'Quién lo recogió'),
      arrived_at = coalesce(arrived_at, now()), arrived_by_name = coalesce(arrived_by_name, me.full_name)
    where id = k.id returning * into k;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(array_remove(array[k.created_by], me.id),
      format('✅ Entregado: %s', v_who),
      concat_ws(' · ', 'Lo recogió: ' || k.picked_up_by, 'entregó ' || me.full_name) || '.',
      v_link, v_tag, false);
  elsif p_step = 'cancelled' then
    if not (v_security or k.created_by = me.id) then raise exception 'Solo quien la anotó o Seguridad pueden cancelarla.'; end if;
    update public.student_pickups set status = 'cancelled', cancelled_at = now(), cancelled_by_name = me.full_name
    where id = k.id returning * into k;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(
      array_remove(case when k.created_by = me.id then private.perm_ids(me.school_id, 'security', me.id) else array[k.created_by] end, me.id),
      format('Salida cancelada: %s', v_who), format('La canceló %s.', me.full_name), v_link, v_tag, false);
  else
    raise exception 'Paso no válido.';
  end if;
  return k;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: Relevo
-- ---------------------------------------------------------------------------

create or replace function public.request_relief(p_room text, p_note text)
returns public.relief_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.relief_requests;
  v_room text := private.clean_text(p_room, 40, 'El salón');
  v_note text := private.clean_text(p_note, 200, 'La nota');
begin
  if me.role = 'admin' or not exists (
    select 1 from public.school_roles x where x.school_id = me.school_id and x.key = me.role and x.coverage
  ) then
    raise exception 'Pedir relevo es para los maestros.';
  end if;
  select * into r from public.relief_requests x
  where x.requested_by = me.id and x.taken_at is null and x.cancelled_at is null and x.created_at > now() - interval '30 minutes'
  limit 1;
  if r.id is not null then return r; end if;
  insert into public.relief_requests (school_id, requested_by, requested_by_name, room, note)
  values (me.school_id, me.id, me.full_name, v_room, v_note)
  returning * into r;
  perform private.notify_tagged(private.relief_ids(me.school_id, me.id),
    format('🙋 %s pide relevo', me.full_name),
    coalesce(nullif(concat_ws(' · ', 'Salón ' || v_room, v_note), '') || '. ', '') || 'Toca «Yo lo relevo» si puedes ir.',
    '#/alerts/relief/' || r.id, 'relief-' || r.id, true);
  return r;
end;
$$;

/** The first one wins; everyone else is told someone is already going. */
create or replace function public.take_relief(p_id bigint)
returns public.relief_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.relief_requests;
  v_link text := '#/alerts/relief/' || p_id;
begin
  select * into r from public.relief_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null or not private.in_relief_audience() then raise exception 'No se encontró el pedido de relevo.'; end if;
  if r.requested_by = me.id then raise exception 'No puedes relevarte a ti mismo.'; end if;
  if r.cancelled_at is not null then raise exception '% ya no necesita relevo.', r.requested_by_name; end if;
  if r.taken_at is not null then raise exception 'Ya va % a relevar a %.', r.taken_by_name, r.requested_by_name; end if;
  update public.relief_requests set taken_at = now(), taken_by = me.id, taken_by_name = me.full_name
  where id = r.id returning * into r;
  perform private.close_notifications(v_link);
  perform private.notify_tagged(array[r.requested_by]::uuid[],
    format('✅ %s va a relevarte', me.full_name), coalesce('Salón ' || r.room || '.', 'Va en camino.'), v_link, 'relief-' || r.id, false);
  perform private.notify_tagged(array_remove(private.relief_ids(me.school_id, me.id), r.requested_by),
    format('Ya va %s a relevar a %s', me.full_name, r.requested_by_name), 'No hace falta que vaya nadie más.',
    v_link, 'relief-' || r.id, false);
  return r;
end;
$$;

create or replace function public.cancel_relief(p_id bigint)
returns public.relief_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.relief_requests;
  v_link text := '#/alerts/relief/' || p_id;
begin
  select * into r from public.relief_requests x where x.id = p_id and x.requested_by = me.id for update;
  if r.id is null then raise exception 'No se encontró el pedido de relevo.'; end if;
  if r.cancelled_at is not null or r.taken_at is not null then return r; end if;
  update public.relief_requests set cancelled_at = now() where id = r.id returning * into r;
  perform private.close_notifications(v_link);
  perform private.notify_tagged(private.relief_ids(me.school_id, me.id),
    format('%s ya no necesita relevo', me.full_name), 'Se resolvió.', v_link, 'relief-' || r.id, false);
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------

select cron.schedule('hallway-urgent-repeat', '* * * * *', $job$select private.repeat_urgent()$job$);
select cron.schedule('hallway-hourly-purge', '17 * * * *', $job$insert into public.outbox (kind, payload) values ('purge', '{}'::jsonb)$job$);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.notify_tagged(uuid[], text, text, text, text, boolean), private.close_notifications(text), private.repeat_urgent(),
  private.perm_ids(uuid, text, uuid), private.all_staff_ids(uuid, uuid), private.relief_ids(uuid, uuid),
  private.student_key(text), private.school_group(uuid, text), private.note_student(public.profiles, bigint, text, text),
  private.time_text(time)
  from public, anon, authenticated;
-- Used by the row level security policies.
revoke execute on function private.in_relief_audience(), private.can_see_student(bigint, text, uuid) from public, anon;
grant execute on function private.in_relief_audience(), private.can_see_student(bigint, text, uuid) to authenticated;

revoke execute on function
  public.mark_alerts_read(text),
  public.similar_students(text, text),
  public.create_student_alert(bigint, text, text, text, text, text, text),
  public.resolve_student_alert(bigint, text),
  public.create_pickup(bigint, text, text, time, text, text),
  public.advance_pickup(bigint, text, text),
  public.request_relief(text, text),
  public.take_relief(bigint),
  public.cancel_relief(bigint)
  from public, anon;
grant execute on function
  public.mark_alerts_read(text),
  public.similar_students(text, text),
  public.create_student_alert(bigint, text, text, text, text, text, text),
  public.resolve_student_alert(bigint, text),
  public.create_pickup(bigint, text, text, time, text, text),
  public.advance_pickup(bigint, text, text),
  public.request_relief(text, text),
  public.take_relief(bigint),
  public.cancel_relief(bigint)
  to authenticated;

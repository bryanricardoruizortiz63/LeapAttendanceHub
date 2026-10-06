-- Turnos: Enfermería, Trabajo Social and other services.
--   * A teacher asks for a turn for a student: service, student and group, how serious it is (Baja, Media, Alta,
--     Urgente), the reason (a category of the service) and a note. Only the teacher who asked and the service see
--     the reason and the note; the other teachers of the group see how the turn is going, not why.
--   * The service sees its queue: most serious first and, within each level, first come first served. Every 30
--     minutes of waiting a turn goes up one level (up to Alta) so that mild cases aren't forgotten. The
--     professional can take another one; it's recorded.
--   * "The student goes" (Enfermería): the nurse calls the student; the teacher gets "Envía a Juan" and taps
--     "Ya salió". If the student isn't there in time (5 minutes by default), the service, the teacher and
--     Seguridad are warned: Seguridad gets a "No ha llegado" alert. The nurse marks "Llegó", then "Regresa al
--     salón" (the teacher marks "Llegó al salón"), "Lo recogieron" or "Referido".
--   * "The professional goes" (Trabajo Social): "Voy en camino" tells the teacher; then "Atendido" or "Referido".
--   * Each professional says whether they're available, in a meeting, at lunch or out until a given time.
--   * The service keeps its history with names for the school year and only the service sees it; teachers see
--     the turns of their groups for 24 hours.
-- Services are set up by whoever has the "settings" permission; each one says which roles attend it.

-- ---------------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------------

create table public.school_services (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  name text not null check (char_length(name) between 2 and 40 and name = btrim(name)),
  -- visit: the student goes to the service's office · room: the professional goes to the room.
  mode text not null check (mode in ('visit', 'room')),
  -- visit: minutes the student has to get there after being called (or after leaving the room).
  arrive_minutes smallint not null default 5 check (arrive_minutes between 1 and 30),
  -- The roles whose people attend the service (and the only ones who see its history).
  roles text[] not null default '{}' check (cardinality(roles) <= 10),
  -- What the teacher chooses as the reason.
  reasons text[] not null default '{}' check (cardinality(reasons) <= 20),
  active boolean not null default true,
  position int not null default 100,
  created_at timestamptz not null default now()
);
create unique index school_services_name on public.school_services (school_id, lower(name));

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
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', '{}', false, false, 60),
    (p_school, 'seguridad', 'Seguridad', array['security'], false, false, 70)
  on conflict do nothing
$$;

create or replace function private.add_default_services(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_services (school_id, name, mode, arrive_minutes, roles, reasons, position) values
    (p_school, 'Enfermería', 'visit', 5, array['enfermeria'],
      array['Dolor de cabeza', 'Dolor de estómago', 'Fiebre o malestar', 'Golpe o herida', 'Náuseas o vómito',
        'Asma o respiración', 'Medicamento', 'Otro'], 10),
    (p_school, 'Trabajo Social', 'room', 5, array['trabajo_social'],
      array['Conducta', 'Situación emocional', 'Conflicto con compañeros', 'Situación familiar', 'Asistencia', 'Otro'], 20)
  on conflict do nothing
$$;

select private.add_default_roles(id) from public.schools;
select private.add_default_services(id) from public.schools;

create or replace function private.seed_school_roles()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.add_default_roles(new.id);
  perform private.add_default_services(new.id);
  return new;
end;
$$;

-- Available unless they said otherwise today.
create table public.service_staff_status (
  user_id uuid primary key references public.profiles on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  status text not null check (status in ('available', 'meeting', 'lunch', 'away')),
  until timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Turns
-- ---------------------------------------------------------------------------

create table public.service_requests (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  service_id bigint not null references public.school_services on delete cascade,
  student_id bigint references public.students on delete set null,
  -- The service keeps the name in its history (the school year); teachers only see the turn for 24 hours.
  student_name text not null check (char_length(student_name) between 2 and 100),
  student_key text not null,
  group_name text not null,
  room text check (char_length(room) <= 40),
  -- 1 Baja · 2 Media · 3 Alta · 4 Urgente
  severity smallint not null check (severity between 1 and 4),
  -- visit: waiting → called → sent (left the room) → arrived → returning → done
  -- room:  waiting → on_the_way → done
  status text not null default 'waiting'
    check (status in ('waiting', 'called', 'sent', 'arrived', 'on_the_way', 'returning', 'done', 'cancelled')),
  -- expired: nobody closed it that day.
  outcome text check (outcome in ('returned', 'picked_up', 'referred', 'attended', 'cancelled', 'expired')),
  -- The teacher who has the student now: told to send them and when they come back. Starts as whoever asked;
  -- another teacher of the group takes it over with "Está conmigo".
  teacher_id uuid references public.profiles on delete set null,
  teacher_name text,
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  -- The professional who called the student or went to the room.
  handled_by uuid references public.profiles on delete set null,
  handled_by_name text,
  -- Called while there were turns ahead of it.
  out_of_order boolean not null default false,
  called_at timestamptz,
  sent_at timestamptz,
  -- visit: by when the student should be there · late_at: when the "No ha llegado" warning went out.
  due_at timestamptz,
  late_at timestamptz,
  arrived_at timestamptz,
  on_the_way_at timestamptz,
  returning_at timestamptz,
  closed_at timestamptz,
  closed_by_name text
);
create index service_requests_open on public.service_requests (service_id, created_at) where status not in ('done', 'cancelled');
create index service_requests_school on public.service_requests (school_id, created_at desc);
create index service_requests_student on public.service_requests (service_id, student_key, group_name);
create index service_requests_due on public.service_requests (due_at) where status in ('called', 'sent') and late_at is null;

-- What the teacher wrote: only the teacher who asked (for 24 hours) and the service see it.
create table public.service_request_details (
  request_id bigint primary key references public.service_requests on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  service_id bigint not null references public.school_services on delete cascade,
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  reason text check (char_length(reason) <= 40),
  note text check (char_length(note) <= 500)
);

-- The "No ha llegado" alert sent when a student called by a service doesn't get there in time.
alter table public.student_alerts add column turn_id bigint references public.service_requests on delete set null;
create index student_alerts_turn on public.student_alerts (turn_id) where turn_id is not null;
-- The view picks up the new column (at the end, so the view can be replaced in place).
create or replace view public.student_alerts_v with (security_invoker = true) as
  select a.id, a.school_id, a.student_id, a.group_name, a.place, a.room, a.note, a.audience, a.created_by,
    a.created_by_name, a.created_at, a.resolved_at, a.resolved_by, a.resolved_by_name, a.found_place,
    s.name as student_name, a.turn_id
  from public.student_alerts a left join public.students s on s.id = a.student_id;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.severity_text(p_severity int)
returns text
language sql immutable set search_path = ''
as $$
  select (array['Baja', 'Media', 'Alta', 'Urgente'])[p_severity]
$$;

/** The level of a waiting turn now: every 30 minutes of waiting it goes up one (up to Alta); Urgente stays first. */
create or replace function private.turn_level(p_severity int, p_created_at timestamptz)
returns int
language sql stable set search_path = ''
as $$
  select case when p_severity >= 4 then 4
    else least(3, p_severity + greatest(0, floor(extract(epoch from now() - p_created_at) / 1800))::int) end
$$;

/** Place of a waiting turn in its service's queue (1 = next); null when it isn't waiting. */
create or replace function private.turn_position(p_id bigint)
returns int
language sql stable security definer set search_path = ''
as $$
  select case when r.status = 'waiting' then 1 + (
    select count(*)::int from public.service_requests x
    where x.service_id = r.service_id and x.status = 'waiting' and x.id <> r.id
      and (private.turn_level(x.severity, x.created_at) > private.turn_level(r.severity, r.created_at)
        or (private.turn_level(x.severity, x.created_at) = private.turn_level(r.severity, r.created_at)
          and (x.created_at, x.id) < (r.created_at, r.id)))
  ) end
  from public.service_requests r where r.id = p_id
$$;

/** Whether the signed-in person attends this service (by their role). */
create or replace function private.serves(p_service_id bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.school_services s
    join public.profiles p on p.school_id = s.school_id
    where s.id = p_service_id and p.id = auth.uid() and p.active and p.role = any(s.roles)
  )
$$;

create or replace function private.service_staff_ids(p_service_id bigint, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.school_services s
  join public.profiles p on p.school_id = s.school_id
  where s.id = p_service_id and p.active and p.role = any(s.roles) and p.id is distinct from p_exclude
$$;

/** The people in a who aren't in b. */
create or replace function private.uuid_minus(a uuid[], b uuid[])
returns uuid[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(x), '{}') from unnest(a) x
  where x is not null and not x = any(array_remove(coalesce(b, '{}'), null))
$$;

/** What a professional's status is now: one from an earlier day, or past its time, is over. */
create or replace function private.staff_status(st public.service_staff_status)
returns text
language sql stable set search_path = ''
as $$
  select case
    when st.user_id is null or st.status = 'available' then 'available'
    when st.until is not null and st.until <= now() then 'available'
    when st.updated_at < now() - interval '12 hours' then 'available'
    else st.status end
$$;

/** The student got there (or the turn ended): closes the "No ha llegado" alert the turn sent to Seguridad. */
create or replace function private.end_turn_alert(p_turn_id bigint, p_found text, me public.profiles)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  a public.student_alerts;
  v_name text;
begin
  for a in select * from public.student_alerts x where x.turn_id = p_turn_id and x.resolved_at is null for update loop
    update public.student_alerts
    set resolved_at = now(), resolved_by = me.id, resolved_by_name = me.full_name, found_place = p_found
    where id = a.id;
    perform private.close_notifications('#/alerts/missing/' || a.id);
    select s.name into v_name from public.students s where s.id = a.student_id;
    -- The teacher and the service hear it through the turn.
    perform private.notify_tagged(
      private.uuid_minus(private.perm_ids(a.school_id, 'security', me.id), array[a.created_by]),
      format('✅ Apareció: %s (%s)', coalesce(v_name, 'estudiante'), a.group_name),
      concat_ws(' · ', p_found, 'lo confirmó ' || me.full_name) || '.',
      '#/alerts/missing/' || a.id, 'missing-' || a.id, false);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who sees what
-- ---------------------------------------------------------------------------

alter table public.school_services enable row level security;
create policy "Ver servicios de mi escuela" on public.school_services for select to authenticated
  using (school_id = (select private.my_school_id()));

-- Read through services_overview().
alter table public.service_staff_status enable row level security;

-- The service: all its turns. Teachers: for 24 hours, the ones they asked for, have now, or are of their groups.
alter table public.service_requests enable row level security;
create policy "Ver turnos" on public.service_requests for select to authenticated
  using (school_id = (select private.my_school_id()) and (
    private.serves(service_id)
    or (created_at > now() - interval '24 hours' and (
      created_by = (select auth.uid()) or teacher_id = (select auth.uid())
      or group_name = any(coalesce((select p.groups from public.profiles p where p.id = (select auth.uid())), '{}'))))));

alter table public.service_request_details enable row level security;
create policy "Ver motivo del turno" on public.service_request_details for select to authenticated
  using (school_id = (select private.my_school_id()) and (
    private.serves(service_id) or (created_by = (select auth.uid()) and created_at > now() - interval '24 hours')));

revoke insert, update, delete, truncate
  on public.school_services, public.service_staff_status, public.service_requests, public.service_request_details
  from anon, authenticated;
revoke all on public.school_services, public.service_staff_status, public.service_requests, public.service_request_details from anon;

-- reason and note come back empty for whoever can't see them. level and position: for the waiting ones.
create view public.service_requests_v with (security_invoker = true) as
  select r.*, s.name as service_name, s.mode as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;
revoke all on public.service_requests_v from anon;
revoke insert, update, delete, truncate on public.service_requests_v from authenticated;

-- ---------------------------------------------------------------------------
-- RPC: services and the professionals' status
-- ---------------------------------------------------------------------------

/**
 * The services (inactive ones only for whoever sets them up): whether I attend each one, how many turns are
 * waiting, and who is available.
 */
create or replace function public.services_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'mode', s.mode, 'arrive_minutes', s.arrive_minutes,
        'roles', to_jsonb(s.roles), 'reasons', to_jsonb(s.reasons), 'active', s.active,
        'serves', me.role = any(s.roles),
        'waiting', (select count(*) from public.service_requests x where x.service_id = s.id and x.status = 'waiting'),
        'staff', (
          select coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id, 'name', p.full_name, 'status', private.staff_status(st),
              'until', case when private.staff_status(st) <> 'available' then st.until end)
            order by p.full_name), '[]'::jsonb)
          from public.profiles p
          left join public.service_staff_status st on st.user_id = p.id
          where p.school_id = s.school_id and p.active and p.role = any(s.roles))
      ) order by s.position, s.name)
    from public.school_services s
    where s.school_id = me.school_id and (s.active or private.can(me, 'settings'))
  ), '[]'::jsonb);
end;
$$;

/** Disponible, En reunión, Almuerzo or Fuera hasta… (until: optional, required for "away"). */
create or replace function public.set_my_service_status(p_status text, p_until timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_until timestamptz := case when p_status = 'available' then null else p_until end;
begin
  if not exists (select 1 from public.school_services s where s.school_id = me.school_id and me.role = any(s.roles)) then
    raise exception 'Tu rol no atiende ningún servicio.';
  end if;
  if p_status is null or p_status not in ('available', 'meeting', 'lunch', 'away') then raise exception 'Estado no válido.'; end if;
  if p_status = 'away' and v_until is null then raise exception 'Elige hasta qué hora estarás fuera.'; end if;
  if v_until is not null and (v_until <= now() or v_until > now() + interval '12 hours') then
    raise exception 'Elige una hora de hoy, más tarde que ahora.';
  end if;
  insert into public.service_staff_status (user_id, school_id, status, until, updated_at)
  values (me.id, me.school_id, p_status, v_until, now())
  on conflict (user_id) do update
    set school_id = excluded.school_id, status = excluded.status, until = excluded.until, updated_at = excluded.updated_at;
  return jsonb_build_object('status', p_status, 'until', v_until);
end;
$$;

/** Adds (p_id null) or changes a service. A service with turns isn't deleted: it's deactivated. */
create or replace function public.save_service(
  p_id bigint, p_name text, p_mode text, p_arrive_minutes int, p_roles text[], p_reasons text[], p_active boolean
)
returns public.school_services
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_roles text[];
  v_reasons text[];
begin
  if not private.can(me, 'settings') then raise exception 'No tienes permiso para cambiar los servicios.'; end if;
  if char_length(v_name) < 2 then raise exception 'Escribe el nombre del servicio.'; end if;
  if char_length(v_name) > 40 then raise exception 'El nombre es demasiado largo (máx. 40 caracteres).'; end if;
  if p_mode is null or p_mode not in ('visit', 'room') then raise exception 'Elige cómo funciona el servicio.'; end if;
  if p_arrive_minutes is null or p_arrive_minutes not between 1 and 30 then
    raise exception 'El tiempo para llegar debe ser de 1 a 30 minutos.';
  end if;
  select coalesce(array_agg(r.key order by r.position, r.name), '{}') into v_roles
  from public.school_roles r
  where r.school_id = me.school_id and not r.system and r.key = any(coalesce(p_roles, '{}'));
  if cardinality(v_roles) = 0 then raise exception 'Elige qué rol atiende el servicio.'; end if;
  if cardinality(v_roles) > 10 then raise exception 'Hasta 10 roles por servicio.'; end if;
  -- One per line, without repeats (case doesn't matter), in the order written.
  select coalesce(array_agg(x.t order by x.i), '{}') into v_reasons
  from (
    select distinct on (lower(c.t)) c.t, c.i
    from (
      select regexp_replace(btrim(u.raw), '\s+', ' ', 'g') as t, u.i
      from unnest(coalesce(p_reasons, '{}'::text[])) with ordinality as u(raw, i)
    ) c
    where c.t <> ''
    order by lower(c.t), c.i
  ) x;
  if exists (select 1 from unnest(v_reasons) t where char_length(t) > 40) then
    raise exception 'Cada motivo puede tener hasta 40 caracteres.';
  end if;
  if cardinality(v_reasons) > 20 then raise exception 'Hasta 20 motivos por servicio.'; end if;

  begin
    if p_id is null then
      if (select count(*) from public.school_services x where x.school_id = me.school_id) >= 12 then
        raise exception 'Llegaste al máximo de servicios (12).';
      end if;
      insert into public.school_services (school_id, name, mode, arrive_minutes, roles, reasons, active, position)
      values (me.school_id, v_name, p_mode, p_arrive_minutes, v_roles, v_reasons, coalesce(p_active, true),
        coalesce((select max(x.position) + 10 from public.school_services x where x.school_id = me.school_id), 10))
      returning * into s;
    else
      select * into s from public.school_services x where x.id = p_id and x.school_id = me.school_id for update;
      if s.id is null then raise exception 'No se encontró el servicio.'; end if;
      if s.mode <> p_mode and exists (
        select 1 from public.service_requests x where x.service_id = s.id and x.status not in ('done', 'cancelled')
      ) then
        raise exception 'Hay turnos abiertos en %. Termínalos antes de cambiar cómo funciona.', s.name;
      end if;
      update public.school_services
      set name = v_name, mode = p_mode, arrive_minutes = p_arrive_minutes, roles = v_roles, reasons = v_reasons,
        active = coalesce(p_active, active)
      where id = s.id
      returning * into s;
    end if;
  exception when unique_violation then
    raise exception 'Ya hay un servicio llamado «%».', v_name;
  end;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: turns
-- ---------------------------------------------------------------------------

/**
 * A teacher asks for a turn. p_here: the professional notes a student who came on their own and is already
 * in the office (services where the student goes).
 */
create or replace function public.request_service(
  p_service_id bigint, p_student_id bigint, p_name text, p_group text, p_room text,
  p_severity int, p_reason text, p_note text, p_here boolean default false
)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  s public.school_services;
  st public.students;
  r public.service_requests;
  v_room text := private.clean_text(regexp_replace(coalesce(p_room, ''), '\s+', ' ', 'g'), 40, 'El salón');
  v_reason text := private.clean_text(p_reason, 40, 'El motivo');
  v_note text := private.clean_text(p_note, 500, 'La nota');
  v_here boolean;
begin
  select * into s from public.school_services x where x.id = p_service_id and x.school_id = me.school_id and x.active;
  if s.id is null then raise exception 'Ese servicio no está disponible.'; end if;
  if p_severity is null or p_severity not between 1 and 4 then raise exception 'Elige la gravedad.'; end if;
  if cardinality(s.reasons) > 0 and (v_reason is null or not v_reason = any(s.reasons)) then
    raise exception 'Elige el motivo.';
  end if;
  if (select count(*) from public.service_requests x where x.created_by = me.id and x.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Pediste muchos turnos en la última hora. Llama a la oficina.';
  end if;
  v_here := coalesce(p_here, false) and me.role = any(s.roles) and s.mode = 'visit';
  st := private.note_student(me, p_student_id, p_name, p_group);
  select * into r from public.service_requests x
  where x.service_id = s.id and x.student_key = st.name_key and x.group_name = st.group_name
    and x.status not in ('done', 'cancelled')
  limit 1;
  if r.id is not null then
    raise exception 'Ya hay un turno abierto para % (%) en %, pedido por %.', st.name, st.group_name, s.name, r.created_by_name;
  end if;

  insert into public.service_requests (
    school_id, service_id, student_id, student_name, student_key, group_name, room, severity, status,
    teacher_id, teacher_name, created_by, created_by_name, handled_by, handled_by_name, arrived_at
  ) values (
    me.school_id, s.id, st.id, st.name, st.name_key, st.group_name,
    coalesce(v_room, case when not v_here then me.room end), p_severity,
    case when v_here then 'arrived' else 'waiting' end,
    case when not v_here then me.id end, case when not v_here then me.full_name end,
    me.id, me.full_name,
    case when v_here then me.id end, case when v_here then me.full_name end,
    case when v_here then now() end
  )
  returning * into r;
  insert into public.service_request_details (request_id, school_id, service_id, created_by, reason, note)
  values (r.id, me.school_id, s.id, me.id, v_reason, v_note);

  if not v_here then
    perform private.notify_tagged(private.service_staff_ids(s.id, me.id),
      format('📋 %s: %s (%s)', s.name, st.name, st.group_name),
      concat_ws(' · ', private.severity_text(p_severity), v_reason, 'salón ' || r.room, 'pidió ' || me.full_name) || '.',
      '#/turns/' || r.id, 'turn-' || r.id, p_severity = 4);
  end if;
  return r;
end;
$$;

/**
 * The next step of a turn.
 *   The service: call (visit) · go (room: "Voy en camino") · arrived · return ("Regresa al salón") ·
 *     finish with p_value picked_up | referred (visit) or attended | referred (room) · cancel.
 *   The teachers of the student: sent ("Ya salió") · back ("Llegó al salón") · take ("Está conmigo", p_value:
 *     the room) · cancel (whoever asked or has the student, before the student leaves).
 */
create or replace function public.advance_turn(p_id bigint, p_step text, p_value text default null)
returns public.service_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  r public.service_requests;
  s public.school_services;
  v_serves boolean;
  v_teacher boolean;
  v_link text := '#/turns/' || p_id;
  v_tag text := 'turn-' || p_id;
  v_who text;
  v_teachers uuid[];
  v_position int;
  v_old text;
begin
  select * into r from public.service_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if r.id is null then raise exception 'No se encontró el turno.'; end if;
  select * into s from public.school_services x where x.id = r.service_id;
  v_serves := me.role = any(s.roles);
  v_teacher := r.created_at > now() - interval '24 hours'
    and (r.created_by = me.id or r.teacher_id = me.id or r.group_name = any(coalesce(me.groups, '{}')));
  if not (v_serves or v_teacher) then raise exception 'No se encontró el turno.'; end if;
  if r.status in ('done', 'cancelled') then raise exception 'Este turno ya terminó.'; end if;
  v_who := format('%s (%s)', r.student_name, r.group_name);
  v_teachers := array_remove(array[r.teacher_id], me.id);
  v_old := r.status;

  if p_step = 'call' then
    if not v_serves then raise exception 'Solo % llama los turnos.', s.name; end if;
    if s.mode <> 'visit' then raise exception 'En % el profesional va al salón: toca «Voy en camino».', s.name; end if;
    if r.status <> 'waiting' then raise exception 'Este turno ya se llamó.'; end if;
    v_position := private.turn_position(r.id);
    update public.service_requests
    set status = 'called', called_at = now(), due_at = now() + make_interval(mins => s.arrive_minutes),
      handled_by = me.id, handled_by_name = me.full_name, out_of_order = coalesce(v_position, 1) > 1
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 Envía a %s a %s', v_who, s.name),
      format('Tiene %s min para llegar. Toca «Ya salió» cuando lo envíes.', s.arrive_minutes),
      v_link, v_tag, true);

  elsif p_step = 'go' then
    if not v_serves then raise exception 'Solo % marca que va en camino.', s.name; end if;
    if s.mode <> 'room' then raise exception 'En % el estudiante va a la oficina: toca «Llamar».', s.name; end if;
    if r.status <> 'waiting' then raise exception 'Ya alguien va en camino.'; end if;
    v_position := private.turn_position(r.id);
    update public.service_requests
    set status = 'on_the_way', on_the_way_at = now(), handled_by = me.id, handled_by_name = me.full_name,
      out_of_order = coalesce(v_position, 1) > 1
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 %s va a tu salón por %s', s.name, v_who), format('Va %s.', me.full_name), v_link, v_tag, false);

  elsif p_step = 'sent' then
    if not v_teacher then raise exception 'Lo marca el maestro que tiene al estudiante.'; end if;
    if r.status <> 'called' then raise exception 'Este turno no está esperando que salga el estudiante.'; end if;
    -- Whoever sends the student has them: the next notices go to them.
    update public.service_requests
    set status = 'sent', sent_at = now(), due_at = now() + make_interval(mins => s.arrive_minutes),
      teacher_id = me.id, teacher_name = me.full_name,
      room = case when teacher_id is distinct from me.id then coalesce(me.room, room) else room end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);

  elsif p_step = 'arrived' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if s.mode <> 'visit' or r.status not in ('waiting', 'called', 'sent') then
      raise exception 'Este turno no está esperando al estudiante.';
    end if;
    update public.service_requests
    set status = 'arrived', arrived_at = now(),
      handled_by = coalesce(handled_by, me.id), handled_by_name = coalesce(handled_by_name, me.full_name)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if r.late_at is not null then
      perform private.notify_tagged(
        array_cat(v_teachers, private.service_staff_ids(s.id, me.id)),
        format('✅ %s llegó a %s', v_who, s.name), format('Lo recibió %s.', me.full_name), v_link, v_tag, false);
    end if;
    perform private.end_turn_alert(r.id, format('Llegó a %s', s.name), me);

  elsif p_step = 'return' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if r.status <> 'arrived' then raise exception 'El estudiante no está en %.', s.name; end if;
    update public.service_requests set status = 'returning', returning_at = now()
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Toca «Llegó al salón» cuando llegue.', s.name), v_link, v_tag, false);

  elsif p_step = 'back' then
    if not (v_teacher or v_serves) then raise exception 'No se encontró el turno.'; end if;
    if r.status <> 'returning' then raise exception 'Este turno no está esperando que regrese el estudiante.'; end if;
    update public.service_requests
    set status = 'done', outcome = 'returned', closed_at = now(), closed_by_name = me.full_name,
      teacher_id = case when v_teacher then me.id else teacher_id end,
      teacher_name = case when v_teacher then me.full_name else teacher_name end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);

  elsif p_step = 'finish' then
    if not v_serves then raise exception 'Lo marca %.', s.name; end if;
    if s.mode = 'visit' then
      if r.status <> 'arrived' then raise exception 'El estudiante no está en %.', s.name; end if;
      if p_value is null or p_value not in ('picked_up', 'referred') then raise exception 'Elige cómo terminó.'; end if;
    else
      if r.status not in ('waiting', 'on_the_way') then raise exception 'Este turno no está abierto.'; end if;
      if p_value is null or p_value not in ('attended', 'referred') then raise exception 'Elige cómo terminó.'; end if;
    end if;
    update public.service_requests
    set status = 'done', outcome = p_value, closed_at = now(), closed_by_name = me.full_name,
      handled_by = coalesce(handled_by, me.id), handled_by_name = coalesce(handled_by_name, me.full_name)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      case p_value
        when 'picked_up' then format('📋 %s: lo recogieron en %s', v_who, s.name)
        when 'referred' then format('📋 %s: %s lo refirió', v_who, s.name)
        else format('✅ %s atendió a %s', s.name, v_who) end,
      case p_value when 'picked_up' then 'No regresa al salón. ' else '' end || format('Lo marcó %s.', me.full_name),
      v_link, v_tag, false);

  elsif p_step = 'cancel' then
    if not (v_serves or ((r.created_by = me.id or r.teacher_id = me.id) and r.status in ('waiting', 'called'))) then
      raise exception 'Solo quien lo pidió (antes de que salga el estudiante) o % pueden cancelarlo.', s.name;
    end if;
    update public.service_requests
    set status = 'cancelled', outcome = 'cancelled', closed_at = now(), closed_by_name = me.full_name
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.end_turn_alert(r.id, 'Se canceló el turno', me);
    perform private.notify_tagged(
      case when v_serves then v_teachers
        -- The service only needs to hear it once it had called the student.
        when v_old <> 'waiting' then private.service_staff_ids(s.id, me.id)
        else '{}'::uuid[] end,
      format('Turno cancelado: %s', v_who), format('%s · lo canceló %s.', s.name, me.full_name), v_link, v_tag, false);

  elsif p_step = 'take' then
    if not v_teacher then raise exception 'Solo los maestros del grupo pueden hacerlo.'; end if;
    if r.status not in ('waiting', 'called', 'returning') then raise exception 'Ahora no se puede cambiar quién lo tiene.'; end if;
    if r.teacher_id = me.id then return r; end if;
    update public.service_requests
    set teacher_id = me.id, teacher_name = me.full_name,
      room = coalesce(private.clean_text(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), 40, 'El salón'), me.room, room)
    where id = r.id returning * into r;
    if v_old = 'called' then perform private.close_notifications(v_link); end if;
    perform private.notify_tagged(v_teachers,
      format('📋 %s está con %s', v_who, me.full_name),
      format('Los avisos de este turno de %s le llegan ahora a %s.', s.name, me.full_name), v_link, v_tag, false);

  else
    raise exception 'Paso no válido.';
  end if;
  return r;
end;
$$;

/**
 * Every minute (pg_cron): a student called by a service who isn't there in time. The service and the teacher are
 * warned, and Seguridad gets a "No ha llegado" alert. Turns nobody closed that day are closed.
 */
create or replace function private.check_turn_timers()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.service_requests;
  s public.school_services;
  a public.student_alerts;
  v_who text;
  v_mins int;
  v_near uuid[];
  v_since text;
begin
  for r in
    select * from public.service_requests x
    where x.status in ('called', 'sent') and x.late_at is null and x.due_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    update public.service_requests set late_at = now() where id = r.id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - coalesce(r.sent_at, r.called_at)) / 60)::int);
    v_since := case when r.status = 'sent'
      then concat_ws(' ', 'Salió', 'del salón ' || r.room, format('hace %s min', v_mins))
      else concat_ws(' ', format('Lo llamaron hace %s min', v_mins), 'en el salón ' || r.room) || ' y no se confirmó que salió' end;
    v_near := array_append(private.service_staff_ids(s.id, null), r.teacher_id);
    a := null;
    if not exists (
      select 1 from public.student_alerts x
      where x.school_id = r.school_id and x.resolved_at is null
        and (x.turn_id = r.id or (r.student_id is not null and x.student_id = r.student_id))
    ) then
      insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name, turn_id)
      values (r.school_id, r.student_id, r.group_name, format('Iba a %s', s.name), r.room,
        case when r.status = 'called' then 'No se confirmó que salió del salón.' end,
        'security', r.teacher_id, s.name, r.id)
      returning * into a;
      perform private.notify_tagged(private.uuid_minus(private.perm_ids(r.school_id, 'security', null), v_near),
        format('🚨 No ha llegado a %s: %s', s.name, v_who),
        v_since || '. Si lo ves, toca «Apareció».',
        '#/alerts/missing/' || a.id, 'missing-' || a.id, true);
    end if;
    perform private.notify_tagged(v_near,
      format('⏱️ No ha llegado a %s: %s', s.name, v_who),
      v_since || case when a.id is not null then '. Se avisó a Seguridad.' else '.' end,
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end loop;

  -- The end of the day: a student who was going back counts as back; the rest, closed without an outcome.
  update public.service_requests
  set status = case when status = 'returning' then 'done' else 'cancelled' end,
    outcome = case when status = 'returning' then 'returned' else 'expired' end,
    closed_at = now(), closed_by_name = 'Hallway'
  where status not in ('done', 'cancelled') and created_at < now() - interval '14 hours';
end;
$$;

-- ---------------------------------------------------------------------------
-- "No ha llegado": the service also hears when the student turns up
-- ---------------------------------------------------------------------------

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
  v_service bigint;
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
  if a.turn_id is not null then
    select x.service_id into v_service from public.service_requests x where x.id = a.turn_id;
    perform private.notify_tagged(private.service_staff_ids(v_service, me.id),
      format('✅ Apareció: %s (%s)', coalesce(v_name, 'estudiante'), a.group_name),
      concat_ws(' · ', 'Estaba: ' || v_found, 'lo confirmó ' || me.full_name) || '. Márcalo cuando llegue.',
      '#/turns/' || a.turn_id, 'turn-' || a.turn_id, false);
  end if;
  return a;
end;
$$;

/** Opening the alerts (or the turns, '#/turns', or one of them) stops its repeats for me. */
create or replace function public.mark_alerts_read(p_link text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  update public.notifications set read_at = now()
  where user_id = me.id and read_at is null
    and (case
      when p_link is null then link like '#/alerts/%'
      when p_link = '#/turns' then link like '#/turns/%'
      else link = p_link end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

select cron.schedule('hallway-turn-timers', '* * * * *', $job$select private.check_turn_timers()$job$);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.add_default_services(uuid), private.severity_text(int), private.service_staff_ids(bigint, uuid),
  private.uuid_minus(uuid[], uuid[]), private.staff_status(public.service_staff_status),
  private.end_turn_alert(bigint, text, public.profiles), private.check_turn_timers()
  from public, anon, authenticated;
-- Used by the row level security policies and the view.
revoke execute on function private.serves(bigint), private.turn_level(int, timestamptz), private.turn_position(bigint)
  from public, anon;
grant execute on function private.serves(bigint), private.turn_level(int, timestamptz), private.turn_position(bigint)
  to authenticated;

revoke execute on function
  public.services_overview(),
  public.set_my_service_status(text, timestamptz),
  public.save_service(bigint, text, text, int, text[], text[], boolean),
  public.request_service(bigint, bigint, text, text, text, int, text, text, boolean),
  public.advance_turn(bigint, text, text)
  from public, anon;
grant execute on function
  public.services_overview(),
  public.set_my_service_status(text, timestamptz),
  public.save_service(bigint, text, text, int, text[], text[], boolean),
  public.request_service(bigint, bigint, text, text, text, int, text, text, boolean),
  public.advance_turn(bigint, text, text)
  to authenticated;

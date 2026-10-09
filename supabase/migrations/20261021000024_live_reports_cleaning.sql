-- En vivo, Datos y reportes y Mantenimiento:
--   * A permission of its own for "En vivo" (live): the live board, now with the reason of each turn of
--     Enfermería, Trabajo Social… (never the teacher's note). The dirección and Secretaría have it, and so does
--     whoever had "Datos y reportes" (nobody loses it).
--   * "Datos y reportes" (reports) now also gives every service's panel and Excel (turns with their reason, never
--     the notes): the dirección and Administración. Secretaría no longer has it; the Administración account can
--     give it back from Roles y permisos. Each service (Enfermería, Trabajo Social…) still sees only its own.
--   * Mantenimiento only cleans: new requests can't be "Reparación" (the ones already made keep it).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'maintenance']::text[]);

update public.school_roles set permissions = permissions || 'live'::text
where not 'live' = any(permissions) and ('reports' = any(permissions) or key in ('admin', 'director', 'secretary'));

update public.school_roles set permissions = array_remove(permissions, 'reports')
where key = 'secretary' and 'reports' = any(permissions);

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'maintenance'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'live', 'calendar', 'security'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'seguridad', 'Seguridad', array['security'], false, false, 70)
  on conflict do nothing
$$;

/** The same as before, plus the services the person attends (serves: [{ id, name }]) for their panels. */
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
      'room', p.room, 'groups', to_jsonb(p.groups),
      'serves', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.position, x.name)
        from public.school_services x
        where x.school_id = p.school_id and x.active and p.role = any(x.roles)
      ), '[]'::jsonb)
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

-- ---------------------------------------------------------------------------
-- En vivo: with the reason of each turn
-- ---------------------------------------------------------------------------

/**
 * p_since: when "today" started on the phone (the server doesn't know the school's time zone);
 * p_today: the phone's date, for the room reservations.
 * Each service's staff and its turns (student, group and the reason, never the note), open "No ha llegado"
 * alerts, today's pickups and relief requests, open maintenance requests and today's conference room reservations.
 */
create or replace function public.live_board(p_since timestamptz, p_today date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_since timestamptz := greatest(coalesce(p_since, now() - interval '12 hours'), now() - interval '36 hours');
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
begin
  if not private.can(me, 'live') then raise exception 'No tienes permiso para ver el tablero en vivo.'; end if;
  return jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'mode', s.mode,
          'staff', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'name', p.full_name, 'status', private.staff_status(st),
                'until', case when private.staff_status(st) <> 'available' then st.until end)
              order by p.full_name), '[]'::jsonb)
            from public.profiles p
            left join public.service_staff_status st on st.user_id = p.id
            where p.school_id = s.school_id and p.active and p.role = any(s.roles)),
          'active', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'id', r.id, 'student', r.student_name, 'group', r.group_name, 'status', r.status,
                'reason', (select d.reason from public.service_request_details d where d.request_id = r.id),
                'level', case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) else r.severity end,
                'since', coalesce(r.returning_at, r.arrived_at, r.on_the_way_at, r.sent_at, r.called_at, r.created_at),
                'late', r.late_at is not null and r.arrived_at is null,
                'handled_by_name', r.handled_by_name)
              order by r.created_at), '[]'::jsonb)
            from public.service_requests r
            where r.service_id = s.id and r.status in ('waiting', 'called', 'sent', 'arrived', 'on_the_way', 'returning')),
          'today', (
            select jsonb_build_object(
              'requested', count(*),
              'done', count(*) filter (where r.status = 'done'),
              'returned', count(*) filter (where r.outcome = 'returned'),
              'picked_up', count(*) filter (where r.outcome = 'picked_up'),
              'referred', count(*) filter (where r.outcome = 'referred'),
              'late', count(*) filter (where r.late_at is not null))
            from public.service_requests r
            where r.service_id = s.id and r.created_at >= v_since))
        order by s.position, s.name)
      from public.school_services s
      where s.school_id = me.school_id and s.active
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', a.id, 'student', st.name, 'group', a.group_name, 'place', a.place, 'audience', a.audience,
          'created_at', a.created_at, 'created_by_name', a.created_by_name)
        order by a.created_at)
      from public.student_alerts a
      left join public.students st on st.id = a.student_id
      where a.school_id = me.school_id and a.resolved_at is null and a.created_at > now() - interval '24 hours'
    ), '[]'::jsonb),
    'pickups', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', k.id, 'student', st.name, 'group', k.group_name, 'status', k.status, 'expected_time', k.expected_time)
        order by k.expected_time nulls last, k.created_at)
      from public.student_pickups k
      left join public.students st on st.id = k.student_id
      where k.school_id = me.school_id and k.status in ('scheduled', 'arrived', 'on_the_way') and k.created_at >= v_since
    ), '[]'::jsonb),
    'pickups_done', (
      select count(*) from public.student_pickups k
      where k.school_id = me.school_id and k.status = 'delivered' and k.created_at >= v_since),
    'relief', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.requested_by_name, 'room', x.room, 'created_at', x.created_at)
        order by x.created_at)
      from public.relief_requests x
      where x.school_id = me.school_id and x.taken_at is null and x.cancelled_at is null
        and x.created_at > now() - interval '30 minutes'
    ), '[]'::jsonb),
    'maintenance', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', m.id, 'kind', m.kind, 'place', m.place, 'urgency', m.urgency, 'status', m.status,
          'taken_by_name', m.taken_by_name, 'created_at', m.created_at)
        order by m.urgency desc, m.created_at)
      from public.maintenance_requests m
      where m.school_id = me.school_id and m.status in ('pending', 'on_the_way')
    ), '[]'::jsonb),
    'maintenance_done', (
      select count(*) from public.maintenance_requests m
      where m.school_id = me.school_id and m.status = 'done' and m.done_at >= v_since),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', b.id, 'start_time', b.start_time, 'end_time', b.end_time, 'purpose', b.purpose,
          'created_by_name', b.created_by_name)
        order by b.start_time)
      from public.room_bookings b
      where b.school_id = me.school_id and b.day = v_today and b.status = 'approved'
    ), '[]'::jsonb),
    'rooms_pending', (
      select count(*) from public.room_bookings b
      where b.school_id = me.school_id and b.status = 'pending' and b.day >= v_today)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- A service's panel: whoever attends it, and Datos y reportes
-- ---------------------------------------------------------------------------

/**
 * A service's turns made between two moments, with the reason and never the teacher's note: for whoever attends
 * the service and whoever has "Datos y reportes". Ordered by id, so the app can read it in pages.
 */
create or replace function public.service_turns(p_service_id bigint, p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, service_id bigint, student_name text, student_key text, group_name text, severity smallint,
  status text, outcome text, reason text, created_by_name text, handled_by_name text, out_of_order boolean,
  created_at timestamptz, called_at timestamptz, sent_at timestamptz, arrived_at timestamptz,
  on_the_way_at timestamptz, returning_at timestamptz, closed_at timestamptz, late_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not exists (select 1 from public.school_services s where s.id = p_service_id and s.school_id = me.school_id) then
    raise exception 'No se encontró el servicio.';
  end if;
  if not (private.serves(p_service_id) or private.can(me, 'reports')) then
    raise exception 'Solo quien atiende este servicio y la dirección ven su panel.';
  end if;
  return query
    select r.id, r.service_id, r.student_name, r.student_key, r.group_name, r.severity, r.status, r.outcome, d.reason,
      r.created_by_name, r.handled_by_name, r.out_of_order, r.created_at, r.called_at, r.sent_at, r.arrived_at,
      r.on_the_way_at, r.returning_at, r.closed_at, r.late_at
    from public.service_requests r
    left join public.service_request_details d on d.request_id = r.id
    where r.service_id = p_service_id and r.created_at >= p_from and r.created_at < p_to
    order by r.id;
end;
$$;

revoke execute on function public.service_turns(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.service_turns(bigint, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Mantenimiento: cleaning only
-- ---------------------------------------------------------------------------

create or replace function public.create_maintenance_request(
  p_kind text, p_place text, p_urgency int, p_note text, p_photo_path text default null
)
returns public.maintenance_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  m public.maintenance_requests;
  v_place text := private.clean_text(regexp_replace(coalesce(p_place, ''), '\s+', ' ', 'g'), 80, 'El lugar');
  v_note text := private.clean_text(p_note, 500, 'La nota');
  v_photo text := nullif(btrim(coalesce(p_photo_path, '')), '');
begin
  if p_kind = 'repair' then
    raise exception 'Mantenimiento solo se encarga de la limpieza: las reparaciones se piden a la dirección.';
  end if;
  if p_kind is null or p_kind not in ('spill', 'cleaning', 'bathroom', 'trash', 'other') then
    raise exception 'Elige qué hace falta.';
  end if;
  if v_place is null then raise exception 'Escribe dónde es.'; end if;
  if p_urgency is null or p_urgency not between 1 and 3 then raise exception 'Elige la urgencia.'; end if;
  if p_kind = 'other' and v_note is null then raise exception 'Escribe qué hace falta.'; end if;
  if (select count(*) from public.maintenance_requests x where x.created_by = me.id and x.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Enviaste muchas solicitudes en la última hora. Llama a la oficina.';
  end if;
  if v_photo is not null and (
    v_photo not like me.school_id::text || '/' || me.id::text || '/%'
    or not exists (select 1 from storage.objects o where o.bucket_id = 'maintenance' and o.name = v_photo)
  ) then
    raise exception 'No se encontró la foto. Inténtalo de nuevo.';
  end if;
  -- Someone already asked for the same thing in the same place.
  select * into m from public.maintenance_requests x
  where x.school_id = me.school_id and x.kind = p_kind and lower(x.place) = lower(v_place) and x.status in ('pending', 'on_the_way')
  limit 1;
  if m.id is not null then
    raise exception 'Ya hay una solicitud abierta de % en %: la envió %.', lower(private.maintenance_kind_text(p_kind)), m.place, m.created_by_name;
  end if;

  insert into public.maintenance_requests (school_id, kind, place, urgency, note, photo_path, created_by, created_by_name)
  values (me.school_id, p_kind, v_place, p_urgency, v_note, v_photo, me.id, me.full_name)
  returning * into m;
  perform private.notify_tagged(private.maintenance_ids(me.school_id, me.id),
    format('🧹 %s: %s', private.maintenance_kind_text(p_kind), v_place),
    concat_ws(' · ', private.urgency_text(p_urgency), v_note, case when v_photo is not null then 'con foto' end, 'avisó ' || me.full_name) || '.',
    '#/maintenance/' || m.id, 'maint-' || m.id, p_urgency >= 2);
  return m;
end;
$$;

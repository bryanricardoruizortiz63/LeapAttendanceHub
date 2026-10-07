-- Turnos: back to class.
--   * "Regresa al salón" starts the time to get to class: the service's minutes to arrive (5 by default). If nobody
--     marks «Llegó al salón» in that time, the teacher who had the student, the other teachers of the group and the
--     service are warned with an alarm, and Seguridad gets a "No ha llegado" alert ("Regresaba de Enfermería").
--   * When another teacher (or the service) marks «Llegó al salón», the teacher who had sent the student hears it.
--   * At the end of the day a return nobody confirmed is "Regreso sin confirmar", not "Regresó al salón".

-- When the "No ha llegado al salón" warning went out (late_at is the way to the service).
alter table public.service_requests add column return_late_at timestamptz;
alter table public.service_requests drop constraint service_requests_outcome_check,
  add constraint service_requests_outcome_check
    check (outcome in ('returned', 'picked_up', 'referred', 'attended', 'cancelled', 'expired', 'unconfirmed'));
create index service_requests_return_due on public.service_requests (due_at) where status = 'returning' and return_late_at is null;

-- The view picks up the new column (at the end, so the view can be replaced in place).
create or replace view public.service_requests_v with (security_invoker = true) as
  select r.id, r.school_id, r.service_id, r.student_id, r.student_name, r.student_key, r.group_name, r.room,
    r.severity, r.status, r.outcome, r.teacher_id, r.teacher_name, r.created_by, r.created_by_name, r.created_at,
    r.handled_by, r.handled_by_name, r.out_of_order, r.called_at, r.sent_at, r.due_at, r.late_at, r.arrived_at,
    r.on_the_way_at, r.returning_at, r.closed_at, r.closed_by_name,
    s.name as service_name, s.mode as service_mode, d.reason, d.note,
    case when r.status = 'waiting' then private.turn_level(r.severity, r.created_at) end as level,
    private.turn_position(r.id) as position,
    r.return_late_at
  from public.service_requests r
  join public.school_services s on s.id = r.service_id
  left join public.service_request_details d on d.request_id = r.id;

/**
 * The next step of a turn.
 *   The service: call (visit) · go (room: "Voy en camino") · arrived · return ("Regresa al salón") ·
 *     finish with p_value picked_up | referred (visit) or attended | referred (room) · cancel.
 *   The teachers of the student: sent ("Ya salió") · back ("Llegó al salón") · take ("Está conmigo", p_value:
 *     the room) · cancel (whoever asked or has the student, before the student leaves).
 * Calling, going for and sending back a student also reach the other teachers of the group, without an alarm: the
 * student may be in another class by then. Sending them back starts the time to get to class (the service's minutes
 * to arrive); whoever had the student hears when another teacher (or the service) marks that they got there.
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
  v_group uuid[];
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
  v_group := private.group_teacher_ids(r.school_id, r.group_name, array[me.id, r.teacher_id]);
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
    perform private.notify_tagged(v_group,
      format('📋 Llamaron a %s a %s', v_who, s.name),
      'Si está contigo, envíalo y toca «Ya salió».', v_link, v_tag, false);

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
    perform private.notify_tagged(v_group,
      format('📋 %s va a buscar a %s', s.name, v_who),
      concat_ws(' ', case when r.room is not null then format('Va al salón %s.', r.room) end,
        'Si está contigo, toca «Está conmigo» y pon tu salón.'),
      v_link, v_tag, false);

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
    update public.service_requests
    set status = 'returning', returning_at = now(), due_at = now() + make_interval(mins => s.arrive_minutes)
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Toca «Llegó al salón» cuando llegue; tiene %s min.', s.name, s.arrive_minutes), v_link, v_tag, false);
    perform private.notify_tagged(v_group,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Si llega a tu salón, toca «Llegó al salón».', s.name), v_link, v_tag, false);

  elsif p_step = 'back' then
    if not (v_teacher or v_serves) then raise exception 'No se encontró el turno.'; end if;
    if r.status <> 'returning' then raise exception 'Este turno no está esperando que regrese el estudiante.'; end if;
    update public.service_requests
    set status = 'done', outcome = 'returned', closed_at = now(), closed_by_name = me.full_name,
      teacher_id = case when v_teacher then me.id else teacher_id end,
      teacher_name = case when v_teacher then me.full_name else teacher_name end
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    if r.return_late_at is not null then
      -- Everyone who was warned that the student hadn't got to class hears that they did.
      perform private.notify_tagged(
        private.uuid_minus(array_cat(array_cat(v_teachers, v_group), private.service_staff_ids(s.id, null)), array[me.id]),
        format('✅ %s llegó al salón', v_who), format('Lo recibió %s.', me.full_name), v_link, v_tag, false);
      perform private.end_turn_alert(r.id, 'Llegó al salón', me);
    else
      -- Whoever sent the student (they may be in another class now).
      perform private.notify_tagged(v_teachers,
        format('✅ %s llegó al salón', v_who),
        case when v_teacher then concat_ws(' ', 'Lo recibió ' || me.full_name, 'en el salón ' || me.room) || '.'
          else format('Lo marcó %s.', me.full_name) end,
        v_link, v_tag, false);
    end if;

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
    if r.status not in ('waiting', 'called', 'on_the_way', 'returning') then raise exception 'Ahora no se puede cambiar quién lo tiene.'; end if;
    if r.teacher_id = me.id then return r; end if;
    update public.service_requests
    set teacher_id = me.id, teacher_name = me.full_name,
      room = coalesce(private.clean_text(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g'), 40, 'El salón'), me.room, room)
    where id = r.id returning * into r;
    if v_old = 'called' then perform private.close_notifications(v_link); end if;
    perform private.notify_tagged(v_teachers,
      format('📋 %s está con %s', v_who, me.full_name),
      format('Los avisos de este turno de %s le llegan ahora a %s.', s.name, me.full_name), v_link, v_tag, false);
    -- Whoever is on the way goes to the new room.
    if v_old = 'on_the_way' then
      perform private.notify_tagged(array_remove(array[r.handled_by], me.id),
        case when r.room is not null then format('📋 %s está ahora en el salón %s', v_who, r.room)
          else format('📋 %s está ahora con %s', v_who, me.full_name) end,
        format('Está con %s.', me.full_name), v_link, v_tag, true);
    end if;

  else
    raise exception 'Paso no válido.';
  end if;
  return r;
end;
$$;

/**
 * Every minute (pg_cron): a student called by a service who isn't there in time, or sent back who isn't in class in
 * time. The service and the teachers are warned, and Seguridad gets a "No ha llegado" alert. Turns nobody closed
 * that day are closed; a return nobody confirmed stays as "Regreso sin confirmar".
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

  -- On the way back to class: the teacher who had the student, the other teachers of the group and the service.
  for r in
    select * from public.service_requests x
    where x.status = 'returning' and x.return_late_at is null and x.due_at < now()
    for update skip locked
  loop
    select * into s from public.school_services x where x.id = r.service_id;
    update public.service_requests set return_late_at = now() where id = r.id;
    v_who := format('%s (%s)', r.student_name, r.group_name);
    v_mins := greatest(1, round(extract(epoch from now() - r.returning_at) / 60)::int);
    v_since := format('Salió de %s hace %s min', s.name, v_mins);
    v_near := array_cat(array_append(private.service_staff_ids(s.id, null), r.teacher_id),
      private.group_teacher_ids(r.school_id, r.group_name, array[r.teacher_id]));
    a := null;
    if not exists (
      select 1 from public.student_alerts x
      where x.school_id = r.school_id and x.resolved_at is null
        and (x.turn_id = r.id or (r.student_id is not null and x.student_id = r.student_id))
    ) then
      insert into public.student_alerts (school_id, student_id, group_name, place, room, note, audience, created_by, created_by_name, turn_id)
      values (r.school_id, r.student_id, r.group_name, format('Regresaba de %s', s.name), r.room,
        'No se confirmó que llegó al salón.', 'security', r.teacher_id, s.name, r.id)
      returning * into a;
      perform private.notify_tagged(private.uuid_minus(private.perm_ids(r.school_id, 'security', null), v_near),
        format('🚨 No ha llegado al salón: %s', v_who),
        v_since || '. Si lo ves, toca «Apareció».',
        '#/alerts/missing/' || a.id, 'missing-' || a.id, true);
    end if;
    perform private.notify_tagged(v_near,
      format('⏱️ No ha llegado al salón: %s', v_who),
      v_since || case when a.id is not null then '. Se avisó a Seguridad.' else '.' end || ' Si ya llegó, toca «Llegó al salón».',
      '#/turns/' || r.id, 'turn-' || r.id, true);
  end loop;

  -- The end of the day: a return nobody confirmed stays as such; the rest, closed without an outcome.
  update public.service_requests
  set status = case when status = 'returning' then 'done' else 'cancelled' end,
    outcome = case when status = 'returning' then 'unconfirmed' else 'expired' end,
    closed_at = now(), closed_by_name = 'Hallway'
  where status not in ('done', 'cancelled') and created_at < now() - interval '14 hours';
end;
$$;

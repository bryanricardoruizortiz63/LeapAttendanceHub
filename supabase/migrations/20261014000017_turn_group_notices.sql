-- Turnos: the other teachers of the student's group hear about the turn too.
--   * When the service calls the student (or goes for them, or sends them back), the teachers whose groups include
--     the student's group get the notice as well, without an alarm: by then the student may be in another class,
--     and that teacher sends them with «Ya salió» (or says «Está conmigo»). The one who has the student keeps the
--     alarm, as before.
--   * «Está conmigo» also works while Trabajo Social is on the way: they get the new room right away.

/** The active teachers of a group (it's among the groups the dirección gave them), but these ones. */
create or replace function private.group_teacher_ids(p_school uuid, p_group text, p_exclude uuid[])
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}')
  from public.profiles p
  where p.school_id = p_school and p.active and p_group = any(p.groups)
    and not p.id = any(array_remove(coalesce(p_exclude, '{}'), null))
$$;

revoke execute on function private.group_teacher_ids(uuid, text, uuid[]) from public, anon, authenticated;

/**
 * The next step of a turn.
 *   The service: call (visit) · go (room: "Voy en camino") · arrived · return ("Regresa al salón") ·
 *     finish with p_value picked_up | referred (visit) or attended | referred (room) · cancel.
 *   The teachers of the student: sent ("Ya salió") · back ("Llegó al salón") · take ("Está conmigo", p_value:
 *     the room) · cancel (whoever asked or has the student, before the student leaves).
 * Calling, going for and sending back a student also reach the other teachers of the group, without an alarm: the
 * student may be in another class by then.
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
    update public.service_requests set status = 'returning', returning_at = now()
    where id = r.id returning * into r;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(v_teachers,
      format('📋 %s regresa al salón', v_who),
      format('Sale de %s. Toca «Llegó al salón» cuando llegue.', s.name), v_link, v_tag, false);
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

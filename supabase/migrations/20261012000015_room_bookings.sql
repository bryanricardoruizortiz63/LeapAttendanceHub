-- Reservas del salón de conferencias.
--   * Anyone reserves it by hours (from … to …), on a school day and within class hours. Days marked in the
--     school calendar (Feriado or Sin estudiantes) can't be reserved.
--   * Secretaría and the dirección (permission "calendar") approve or reject. When one is approved, the other
--     requests for that time are rejected. Rejected people are told the free times that day.
--   * Their own reservations are approved at once and have priority: over someone else's reservation the app
--     asks first, and then replaces it (that person is told, with the free times that day).
--   * Approved reservations never overlap.
-- Everyone sees the pending and approved reservations (who and what for), so the purpose must not be private.
-- The daily job removes reservations after a year.

create extension if not exists btree_gist with schema extensions;

create table public.room_bookings (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  day date not null,
  start_time time not null,
  end_time time not null,
  purpose text not null check (char_length(purpose) between 1 and 120),
  -- pending → approved | rejected · cancelled (whoever reserved it, or Secretaría / dirección)
  -- · replaced (by a reservation of Secretaría or the dirección)
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'replaced')),
  -- Made by Secretaría or the dirección: approved at once and nobody can replace it.
  priority boolean not null default false,
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by_name text,
  closed_at timestamptz,
  closed_by_name text,
  -- Why it was rejected or cancelled.
  close_note text check (char_length(close_note) <= 300),
  replaced_by bigint references public.room_bookings on delete set null,
  check (end_time > start_time),
  constraint room_bookings_no_overlap exclude using gist (
    school_id with =, tsrange(day + start_time, day + end_time) with &&
  ) where (status = 'approved')
);
create index room_bookings_day on public.room_bookings (school_id, day);
create index room_bookings_open on public.room_bookings (school_id, day) where status = 'pending';

alter table public.room_bookings enable row level security;
create policy "Ver reservas del salón" on public.room_bookings for select to authenticated
  using (school_id = (select private.my_school_id())
    and (status in ('pending', 'approved') or created_by = (select auth.uid()) or (select private.has_perm('calendar'))));

revoke insert, update, delete, truncate on public.room_bookings from anon, authenticated;
revoke all on public.room_bookings from anon;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** "lun 12 oct, 9:00 a. m. – 10:30 a. m." */
create or replace function private.room_when(p_day date, p_start time, p_end time)
returns text
language sql immutable set search_path = ''
as $$
  select private.fmt_date(p_day) || ', ' || private.time_text(p_start) || ' – ' || private.time_text(p_end)
$$;

/** Free times that day within class hours (15 minutes or more): "7:40 a. m. – 9:00 a. m., 11:00 a. m. – 3:30 p. m.". */
create or replace function private.room_free_text(p_school uuid, p_day date)
returns text
language sql stable security definer set search_path = ''
as $$
  with hours as (
    select coalesce(s.day_start, '07:40'::time) as a, coalesce(s.day_end, '15:30'::time) as b
    from (select 1) x left join public.school_settings s on s.school_id = p_school
  ),
  busy as (
    select greatest(r.start_time, h.a) as s, least(r.end_time, h.b) as e
    from public.room_bookings r, hours h
    where r.school_id = p_school and r.day = p_day and r.status = 'approved' and r.end_time > h.a and r.start_time < h.b
  ),
  -- Approved reservations never overlap: the gaps are from the start of the day, and from the end of each one,
  -- to the next one (or the end of the day).
  gaps as (
    select h.a as gs, coalesce((select min(s) from busy), h.b) as ge from hours h
    union all
    select b1.e, coalesce((select min(b2.s) from busy b2 where b2.s >= b1.e), h.b) from busy b1, hours h
  )
  select string_agg(private.time_text(gs) || ' – ' || private.time_text(ge), ', ' order by gs)
  from gaps where ge - gs >= interval '15 minutes'
$$;

/** " Libre ese día: …" (or that nothing is left), to end a notice. Times end in "m.", so no extra period. */
create or replace function private.room_free_sentence(p_school uuid, p_day date)
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(' Libre ese día: ' || private.room_free_text(p_school, p_day), ' Ese día ya no queda tiempo libre.')
$$;

/** The day and times can be reserved: a school day, within class hours and not a day without classes. */
create or replace function private.check_room_time(p_school uuid, p_day date, p_start time, p_end time)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_day_start time;
  v_day_end time;
  v_days smallint[];
  c public.school_closures;
begin
  if p_day is null then raise exception 'Elige el día.'; end if;
  if p_start is null or p_end is null then raise exception 'Elige la hora de inicio y la de fin.'; end if;
  if p_end <= p_start then raise exception 'La hora de fin debe ser después de la de inicio.'; end if;
  if p_end - p_start < interval '15 minutes' then raise exception 'Reserva al menos 15 minutos.'; end if;
  select coalesce(s.day_start, '07:40'), coalesce(s.day_end, '15:30'), coalesce(s.school_days, '{1,2,3,4,5}')
  into v_day_start, v_day_end, v_days
  from (select 1) x left join public.school_settings s on s.school_id = p_school;
  if not extract(isodow from p_day)::smallint = any(v_days) then
    raise exception 'Ese día no hay clases (%). Elige un día de clases.', private.fmt_date(p_day);
  end if;
  if p_start < v_day_start or p_end > v_day_end then
    raise exception 'Elige una hora dentro del horario escolar: de % a %', private.time_text(v_day_start), private.time_text(v_day_end);
  end if;
  select * into c from public.school_closures x
  where x.school_id = p_school and p_day between x.start_date and x.end_date
  order by (x.kind = 'holiday') desc limit 1;
  if c.id is not null then
    raise exception 'Ese día no se puede reservar: % (%).', c.name, case c.kind when 'holiday' then 'feriado' else 'sin estudiantes' end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

/**
 * Reserves the room. Secretaría and the dirección get it approved at once; over someone else's reservation
 * (approved or waiting) they must say p_replace = true, and that reservation is replaced.
 */
create or replace function public.create_room_booking(
  p_day date, p_start time, p_end time, p_purpose text, p_replace boolean default false
)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_priority boolean := private.can(me, 'calendar');
  v_purpose text := private.clean_text(regexp_replace(coalesce(p_purpose, ''), '\s+', ' ', 'g'), 120, 'Para qué es');
  b public.room_bookings;
  x public.room_bookings;
  v_replaced bigint[];
begin
  if v_purpose is null then raise exception 'Escribe para qué es (por ejemplo, «Reunión de padres de 9-B»).'; end if;
  -- One day of margin for time zones; the app checks the hour with the phone's clock.
  if p_day < current_date - 1 then raise exception 'Esa fecha ya pasó.'; end if;
  if p_day > current_date + 365 then raise exception 'Se puede reservar hasta con un año de anticipación.'; end if;
  perform private.check_room_time(me.school_id, p_day, p_start, p_end);
  if (select count(*) from public.room_bookings r where r.created_by = me.id and r.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Hiciste muchas reservas en la última hora. Espera un poco.';
  end if;

  -- One at a time per school, so two people can't take the same time.
  perform pg_advisory_xact_lock(hashtextextended('room_bookings:' || me.school_id::text, 0));

  if exists (
    select 1 from public.room_bookings r
    where r.school_id = me.school_id and r.day = p_day and r.created_by = me.id and r.status in ('pending', 'approved')
      and r.start_time < p_end and r.end_time > p_start
  ) then
    raise exception 'Ya tienes una reserva a esa hora.';
  end if;

  -- Approved reservations that can't be replaced: anyone else's for teachers, Secretaría's or the dirección's for them.
  select * into x from public.room_bookings r
  where r.school_id = me.school_id and r.day = p_day and r.status = 'approved'
    and r.start_time < p_end and r.end_time > p_start and (r.priority or not v_priority)
  order by r.start_time limit 1;
  if x.id is not null then
    raise exception 'Ya está reservado de % a % por %.%', private.time_text(x.start_time), private.time_text(x.end_time),
      x.created_by_name, private.room_free_sentence(me.school_id, p_day);
  end if;

  if v_priority then
    select * into x from public.room_bookings r
    where r.school_id = me.school_id and r.day = p_day and r.status in ('pending', 'approved')
      and r.start_time < p_end and r.end_time > p_start
    order by r.start_time limit 1;
    if x.id is not null and not coalesce(p_replace, false) then
      raise exception 'Ya % de % a % (%). ¿Quieres reemplazarla?',
        case x.status when 'approved' then 'lo reservó ' else 'lo pidió ' end || x.created_by_name,
        private.time_text(x.start_time), private.time_text(x.end_time), x.purpose;
    end if;
    -- First out of the way (approved reservations can't overlap), then the new one.
    with gone as (
      update public.room_bookings r
      set status = 'replaced', closed_at = now(), closed_by_name = me.full_name
      where r.school_id = me.school_id and r.day = p_day and r.status in ('pending', 'approved')
        and r.start_time < p_end and r.end_time > p_start
      returning r.id
    )
    select coalesce(array_agg(id), '{}') into v_replaced from gone;
  end if;

  insert into public.room_bookings (school_id, day, start_time, end_time, purpose, status, priority,
    created_by, created_by_name, approved_at, approved_by_name)
  values (me.school_id, p_day, p_start, p_end, v_purpose,
    case when v_priority then 'approved' else 'pending' end, v_priority, me.id, me.full_name,
    case when v_priority then now() end, case when v_priority then me.full_name end)
  returning * into b;

  if cardinality(v_replaced) > 0 then
    update public.room_bookings set replaced_by = b.id where id = any(v_replaced);
    for x in select * from public.room_bookings r where r.id = any(v_replaced) loop
      perform private.close_notifications('#/rooms/' || x.id);
      perform private.notify_tagged(array[x.created_by]::uuid[],
        '📅 Tu reserva del salón se reemplazó',
        format('%s necesita el salón de conferencias: %s (%s). Tu reserva era «%s», de %s a %s%s', me.full_name,
          private.room_when(p_day, p_start, p_end), v_purpose, x.purpose, private.time_text(x.start_time),
          private.time_text(x.end_time), private.room_free_sentence(me.school_id, p_day)),
        '#/rooms/' || x.id, 'room-' || x.id, false);
    end loop;
  end if;

  if not v_priority then
    perform private.notify_tagged(private.perm_ids(me.school_id, 'calendar', me.id),
      '📅 Reserva del salón por aprobar',
      format('%s · %s · %s.', me.full_name, private.room_when(p_day, p_start, p_end), v_purpose),
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

/** Secretaría or the dirección approve or reject a request (p_note: why not). */
create or replace function public.decide_room_booking(p_id bigint, p_approve boolean, p_note text default null)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_note text := private.clean_text(p_note, 300, 'El motivo');
  b public.room_bookings;
  x public.room_bookings;
begin
  if not private.can(me, 'calendar') then raise exception 'Solo la secretaría o la dirección aprueban las reservas.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room_bookings:' || me.school_id::text, 0));
  select * into b from public.room_bookings r where r.id = p_id and r.school_id = me.school_id for update;
  if b.id is null then raise exception 'No se encontró la reserva.'; end if;
  if b.status <> 'pending' then raise exception 'Esta reserva ya no está esperando respuesta.'; end if;

  if coalesce(p_approve, false) then
    if b.day < current_date - 1 then raise exception 'Esa fecha ya pasó.'; end if;
    perform private.check_room_time(me.school_id, b.day, b.start_time, b.end_time);
    select * into x from public.room_bookings r
    where r.school_id = me.school_id and r.day = b.day and r.status = 'approved'
      and r.start_time < b.end_time and r.end_time > b.start_time
    order by r.start_time limit 1;
    if x.id is not null then
      raise exception 'Choca con la reserva de % (% a %). Recházala o cancela la otra primero.',
        x.created_by_name, private.time_text(x.start_time), private.time_text(x.end_time);
    end if;
    update public.room_bookings set status = 'approved', approved_at = now(), approved_by_name = me.full_name
    where id = b.id returning * into b;
    perform private.close_notifications('#/rooms/' || b.id);
    perform private.notify_tagged(array_remove(array[b.created_by], me.id),
      '✅ Reserva del salón aprobada',
      format('%s · %s. La aprobó %s.', private.room_when(b.day, b.start_time, b.end_time), b.purpose, me.full_name),
      '#/rooms/' || b.id, 'room-' || b.id, false);
    -- The other requests for that time can't be approved any more.
    for x in
      update public.room_bookings r
      set status = 'rejected', closed_at = now(), closed_by_name = me.full_name, close_note = 'Se aprobó otra reserva a esa hora.'
      where r.school_id = me.school_id and r.day = b.day and r.status = 'pending' and r.id <> b.id
        and r.start_time < b.end_time and r.end_time > b.start_time
      returning r.*
    loop
      perform private.close_notifications('#/rooms/' || x.id);
      perform private.notify_tagged(array_remove(array[x.created_by], me.id),
        '📅 Reserva del salón no aprobada',
        format('%s · %s. Se aprobó otra reserva a esa hora.%s', private.room_when(x.day, x.start_time, x.end_time),
          x.purpose, private.room_free_sentence(me.school_id, x.day)),
        '#/rooms/' || x.id, 'room-' || x.id, false);
    end loop;
  else
    update public.room_bookings set status = 'rejected', closed_at = now(), closed_by_name = me.full_name, close_note = v_note
    where id = b.id returning * into b;
    perform private.close_notifications('#/rooms/' || b.id);
    perform private.notify_tagged(array_remove(array[b.created_by], me.id),
      '📅 Reserva del salón no aprobada',
      format('%s · %s. No la aprobó %s%s.%s', private.room_when(b.day, b.start_time, b.end_time), b.purpose,
        me.full_name, coalesce(': ' || rtrim(v_note, '.'), ''), private.room_free_sentence(me.school_id, b.day)),
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

/** Whoever reserved it, or Secretaría / the dirección (p_note: why), cancels a waiting or approved reservation. */
create or replace function public.cancel_room_booking(p_id bigint, p_note text default null)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_note text := private.clean_text(p_note, 300, 'El motivo');
  v_manager boolean := private.can(me, 'calendar');
  b public.room_bookings;
begin
  select * into b from public.room_bookings r where r.id = p_id and r.school_id = me.school_id for update;
  if b.id is null or not (b.created_by = me.id or v_manager) then raise exception 'No se encontró la reserva.'; end if;
  if b.status not in ('pending', 'approved') then raise exception 'Esta reserva ya no está activa.'; end if;
  if b.day < current_date - 1 then raise exception 'Esa reserva ya pasó.'; end if;
  update public.room_bookings set status = 'cancelled', closed_at = now(), closed_by_name = me.full_name, close_note = v_note
  where id = b.id returning * into b;
  perform private.close_notifications('#/rooms/' || b.id);
  if b.created_by is distinct from me.id then
    perform private.notify_tagged(array[b.created_by]::uuid[],
      '📅 Reserva del salón cancelada',
      format('%s · %s. La canceló %s%s.', private.room_when(b.day, b.start_time, b.end_time), b.purpose, me.full_name,
        coalesce(': ' || rtrim(v_note, '.'), '')),
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

-- Opening the reservations stops their notices too.
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
      when p_link in ('#/turns', '#/maintenance', '#/rooms') then link like p_link || '/%'
      else link = p_link end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.room_when(date, time, time), private.room_free_text(uuid, date), private.room_free_sentence(uuid, date),
  private.check_room_time(uuid, date, time, time)
  from public, anon, authenticated;

revoke execute on function
  public.create_room_booking(date, time, time, text, boolean),
  public.decide_room_booking(bigint, boolean, text),
  public.cancel_room_booking(bigint, text)
  from public, anon;
grant execute on function
  public.create_room_booking(date, time, time, text, boolean),
  public.decide_room_booking(bigint, boolean, text),
  public.cancel_room_booking(bigint, text)
  to authenticated;

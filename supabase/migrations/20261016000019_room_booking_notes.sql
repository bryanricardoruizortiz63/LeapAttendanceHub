-- Reservas del salón: notes between whoever asked and Secretaría / the dirección.
--   * When asking for the room, an optional note for whoever approves ("Necesito el proyector y 30 sillas").
--   * Each reservation has its notes: a conversation between the person who asked and Secretaría / the
--     dirección (permission "calendar") about that day. Only they see it: the purpose stays public, the notes
--     don't. Each note is a notice (app and push) for the others in the conversation.
-- The notes go with the reservation when it's removed after a year.

create table public.room_booking_notes (
  id bigint generated always as identity primary key,
  booking_id bigint not null references public.room_bookings on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  user_id uuid references public.profiles on delete set null,
  author_name text not null,
  author_role text not null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index room_booking_notes_booking on public.room_booking_notes (booking_id, id);
create index room_booking_notes_user on public.room_booking_notes (user_id, created_at);

alter table public.room_booking_notes enable row level security;
create policy "Ver notas de reservas del salón" on public.room_booking_notes for select to authenticated
  using (school_id = (select private.my_school_id()) and (
    (select private.has_perm('calendar'))
    or exists (select 1 from public.room_bookings b where b.id = booking_id and b.created_by = (select auth.uid()))));

revoke insert, update, delete, truncate on public.room_booking_notes from anon, authenticated;
revoke all on public.room_booking_notes from anon;

/** "un texto largo…" in at most p_max characters. */
create or replace function private.short_text(p_text text, p_max int)
returns text
language sql immutable set search_path = ''
as $$
  select case when char_length(p_text) > p_max then left(p_text, p_max - 1) || '…' else p_text end
$$;

/** A note on a reservation, by whoever asked for it or by Secretaría / the dirección. */
create or replace function public.add_room_booking_note(p_id bigint, p_body text)
returns public.room_booking_notes
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  b public.room_bookings;
  n public.room_booking_notes;
  v_body text := private.clean_text(p_body, 1000, 'La nota');
begin
  select * into b from public.room_bookings x where x.id = p_id and x.school_id = me.school_id;
  if b.id is null or not (b.created_by = me.id or private.can(me, 'calendar')) then
    raise exception 'No se encontró la reserva.';
  end if;
  if v_body is null then raise exception 'Escribe la nota.'; end if;
  if (select count(*) from public.room_booking_notes x where x.user_id = me.id and x.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Escribiste muchas notas en la última hora. Espera un poco.';
  end if;
  insert into public.room_booking_notes (booking_id, school_id, user_id, author_name, author_role, body)
  values (b.id, me.school_id, me.id, me.full_name, me.role, v_body)
  returning * into n;
  -- The others in the conversation: whoever asked, and Secretaría / the dirección.
  perform private.notify_tagged(
    private.uuid_minus(array_append(private.perm_ids(me.school_id, 'calendar', me.id), b.created_by), array[me.id]),
    '💬 Nota sobre la reserva del salón',
    format('%s: %s · %s (%s)', me.full_name, private.short_text(v_body, 120),
      private.room_when(b.day, b.start_time, b.end_time), b.purpose),
    '#/rooms/' || b.id, 'room-' || b.id, false);
  return n;
end;
$$;

-- The note when asking is a new parameter. The old version moves out of the API, so a call without the note
-- (an app not updated yet) reaches the new one instead of finding two candidates.
alter function public.create_room_booking(date, time, time, text, boolean) set schema private;
alter function private.create_room_booking(date, time, time, text, boolean) rename to create_room_booking_before_notes;
revoke execute on function private.create_room_booking_before_notes(date, time, time, text, boolean) from public, anon, authenticated;

/**
 * Reserves the room. Secretaría and the dirección get it approved at once; over someone else's reservation
 * (approved or waiting) they must say p_replace = true, and that reservation is replaced.
 * p_note: an optional note for whoever approves; it starts the reservation's notes.
 */
create or replace function public.create_room_booking(
  p_day date, p_start time, p_end time, p_purpose text, p_replace boolean default false, p_note text default null
)
returns public.room_bookings
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_priority boolean := private.can(me, 'calendar');
  v_purpose text := private.clean_text(regexp_replace(coalesce(p_purpose, ''), '\s+', ' ', 'g'), 120, 'Para qué es');
  v_note text := private.clean_text(p_note, 1000, 'La nota');
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
  if v_note is not null then
    insert into public.room_booking_notes (booking_id, school_id, user_id, author_name, author_role, body)
    values (b.id, me.school_id, me.id, me.full_name, me.role, v_note);
  end if;

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
      format('%s · %s · %s.', me.full_name, private.room_when(p_day, p_start, p_end), v_purpose)
        || case when v_note is not null then format(' Nota: «%s»', private.short_text(v_note, 120)) else '' end,
      '#/rooms/' || b.id, 'room-' || b.id, false);
  end if;
  return b;
end;
$$;

revoke execute on function private.short_text(text, int) from public, anon, authenticated;
revoke execute on function
  public.create_room_booking(date, time, time, text, boolean, text),
  public.add_room_booking_note(bigint, text)
  from public, anon;
grant execute on function
  public.create_room_booking(date, time, time, text, boolean, text),
  public.add_room_booking_note(bigint, text)
  to authenticated;

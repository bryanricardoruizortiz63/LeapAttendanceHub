-- 1) Only the employee or the school's Administración account can cancel or edit an absence.
--    Cancelling asks for a reason; a wrong date is fixed by editing instead of cancelling.
-- 2) Every edit, cancellation and receipt is kept in absence_history.
-- 3) A daily job (pg_cron) removes cancelled absences 15 days after they were cancelled, with their files.
-- 4) archive_runs records each time a school archives a past period to Excel and frees the space.

create table public.absence_history (
  id bigint generated always as identity primary key,
  absence_id bigint not null references public.absences on delete cascade,
  school_id uuid not null references public.schools on delete cascade,
  actor_id uuid references public.profiles on delete set null,
  actor_name text not null,
  action text not null check (action in ('edited', 'cancelled', 'received')),
  -- [{ "label": "Fecha", "before": "lun 3 nov", "after": "mar 4 nov" }, ...]
  changes jsonb not null default '[]'::jsonb,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index absence_history_absence on public.absence_history (absence_id);
create index absence_history_school on public.absence_history (school_id);
create index absence_history_actor on public.absence_history (actor_id);

create table public.archive_runs (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  date_from date not null,
  date_to date not null,
  absences int not null,
  files int not null,
  bytes bigint not null,
  actor_id uuid references public.profiles on delete set null,
  actor_name text not null,
  created_at timestamptz not null default now()
);
create index archive_runs_school on public.archive_runs (school_id);
create index archive_runs_actor on public.archive_runs (actor_id);

alter table public.absence_history enable row level security;
alter table public.archive_runs enable row level security;

create policy "Ver historial" on public.absence_history for select to authenticated
  using (exists (select 1 from public.absences a where a.id = absence_id));

create policy "Dirección ve los archivos anuales" on public.archive_runs for select to authenticated
  using (school_id = (select private.my_school_id()) and (select private.is_manager()));

revoke insert, update, delete, truncate on public.absence_history, public.archive_runs from anon, authenticated;
revoke all on public.absence_history, public.archive_runs from anon;

-- ---------------------------------------------------------------------------

create or replace function private.require_owner_or_admin(a public.absences, me public.profiles, p_action text)
returns void
language plpgsql stable set search_path = ''
as $$
begin
  if me.role = 'admin' then
    return;
  end if;
  if a.user_id <> me.id then
    raise exception 'Solo el empleado o la cuenta de Administración pueden % esta ausencia.', p_action;
  end if;
  -- One day of margin for time zones; the app itself uses the phone's date.
  if a.end_date < current_date - 1 then
    raise exception 'Esta ausencia ya pasó. Pide a la Administración que la corrija.';
  end if;
end;
$$;

drop function if exists public.cancel_absence(bigint);

-- p_reason: 'no_absence' | 'error' | 'other' (with p_note). Null is accepted from older app versions.
create or replace function public.cancel_absence(p_id bigint, p_reason text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_note text := private.clean_text(p_note, 450, 'El motivo');
  v_why text;
  v_name text;
  v_range text := private.fmt_range(a.start_date, a.end_date);
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia ya estaba cancelada.';
  end if;
  perform private.require_owner_or_admin(a, me, 'cancelar');
  if p_reason is not null and p_reason not in ('no_absence', 'error', 'other') then
    raise exception 'Motivo de cancelación no válido.';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'Escribe el motivo de la cancelación.';
  end if;
  v_why := case p_reason
    when 'no_absence' then concat_ws(' — ', 'Ya no va a faltar', v_note)
    when 'error' then concat_ws(' — ', 'Se registró por error', v_note)
    else v_note
  end;

  update public.absences set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = a.id;
  insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action, note)
  values (a.id, a.school_id, me.id, me.full_name, 'cancelled', v_why);

  select full_name into v_name from public.profiles where id = a.user_id;
  perform private.notify(
    private.staff_ids(me.school_id, me.id), 'Ausencia cancelada: ' || v_name,
    v_range || coalesce(' · ' || v_why, '') || case when me.id <> a.user_id then ' (por ' || me.full_name || ')' else '' end,
    '#/absence/' || a.id
  );
  if me.id <> a.user_id then
    perform private.notify(
      array[a.user_id], 'Tu ausencia fue cancelada',
      v_range || ' · por ' || me.full_name || coalesce(' · ' || v_why, ''), '#/absence/' || a.id
    );
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'cancelled', 'absence_id', a.id));
end;
$$;

create or replace function public.update_absence(
  p_id bigint,
  p_start_date date,
  p_end_date date default null,
  p_partial boolean default false,
  p_start_time time default null,
  p_end_time time default null,
  p_category text default null,
  p_reason text default null,
  p_coverage_notes text default null,
  p_note text default null,
  p_today date default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
  v_partial boolean := coalesce(p_partial, false);
  v_end date;
  v_start_time time;
  v_end_time time;
  v_category text := nullif(btrim(p_category), '');
  v_reason text := private.clean_text(p_reason, 1000, 'La causa');
  v_notes text := private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir');
  v_note text := private.clean_text(p_note, 500, 'El motivo del cambio');
  v_changes jsonb := '[]'::jsonb;
  v_reopen boolean;
  v_history bigint;
  v_name text;
  v_summary text;
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  perform private.require_owner_or_admin(a, me, 'modificar');

  -- Same rules as create_absence.
  if p_start_date is null then
    raise exception 'Selecciona una fecha válida.';
  end if;
  v_end := case when v_partial then p_start_date else coalesce(p_end_date, p_start_date) end;
  if v_end < p_start_date then
    raise exception 'La fecha final no puede ser antes de la fecha inicial.';
  end if;
  if v_end - p_start_date > 90 then
    raise exception 'Una ausencia no puede durar más de 90 días.';
  end if;
  if v_today - p_start_date > 60 then
    raise exception 'La fecha es demasiado antigua (máx. 60 días atrás).';
  end if;
  if p_start_date - v_today > 365 then
    raise exception 'La fecha es demasiado lejana.';
  end if;
  if v_partial then
    if p_start_time is null then
      raise exception 'Indica la hora de inicio de la ausencia.';
    end if;
    v_start_time := p_start_time;
    if p_end_time is not null then
      if p_end_time <= p_start_time then
        raise exception 'La hora final debe ser después de la hora de inicio.';
      end if;
      v_end_time := p_end_time;
    end if;
  end if;
  if v_category is not null and private.category_label(v_category) is null then
    raise exception 'Tipo de ausencia no válido.';
  end if;

  if (p_start_date, v_end) is distinct from (a.start_date, a.end_date) then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Fecha', 'before', private.fmt_range(a.start_date, a.end_date), 'after', private.fmt_range(p_start_date, v_end));
  end if;
  if (v_partial, v_start_time, v_end_time) is distinct from (a.partial, a.start_time, a.end_time) then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Horario',
      'before', private.fmt_schedule(a.partial, a.start_time, a.end_time),
      'after', private.fmt_schedule(v_partial, v_start_time, v_end_time));
  end if;
  if v_category is distinct from a.category then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Tipo',
      'before', coalesce(private.category_label(a.category), 'No especificado'),
      'after', coalesce(private.category_label(v_category), 'No especificado'));
  end if;
  if v_reason is distinct from a.reason then
    v_changes := v_changes || jsonb_build_object('label', 'Causa', 'before', a.reason, 'after', v_reason);
  end if;
  if v_notes is distinct from a.coverage_notes then
    v_changes := v_changes || jsonb_build_object(
      'label', 'Instrucciones para cubrir', 'before', a.coverage_notes, 'after', v_notes);
  end if;
  if jsonb_array_length(v_changes) = 0 then
    raise exception 'No hiciste ningún cambio.';
  end if;

  -- A new date or time has to be confirmed again by the school.
  v_reopen := a.status = 'received'
    and (p_start_date, v_end, v_partial, v_start_time, v_end_time)
      is distinct from (a.start_date, a.end_date, a.partial, a.start_time, a.end_time);

  update public.absences
  set start_date = p_start_date, end_date = v_end, partial = v_partial, start_time = v_start_time,
      end_time = v_end_time, category = v_category, reason = v_reason, coverage_notes = v_notes,
      status = case when v_reopen then 'pending' else status end,
      received_by = case when v_reopen then null else received_by end,
      received_by_name = case when v_reopen then null else received_by_name end,
      received_at = case when v_reopen then null else received_at end,
      updated_at = now()
  where id = a.id;

  insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action, changes, note)
  values (a.id, a.school_id, me.id, me.full_name, 'edited', v_changes, v_note)
  returning id into v_history;

  select full_name into v_name from public.profiles where id = a.user_id;
  v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
    || case when v_reopen then ' · hay que confirmarla de nuevo' else '' end;
  perform private.notify(
    private.staff_ids(me.school_id, me.id), 'Ausencia modificada: ' || v_name, v_summary, '#/absence/' || a.id
  );
  if me.id <> a.user_id then
    perform private.notify(
      array[a.user_id], 'Tu ausencia fue modificada', me.full_name || ' la cambió: ' || v_summary, '#/absence/' || a.id
    );
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object(
    'event', 'edited', 'absence_id', a.id, 'history_id', v_history, 'reopened', v_reopen));
end;
$$;

-- Same as before, and now also recorded in the history.
create or replace function public.receive_absence(p_id bigint, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_comment text := private.clean_text(p_comment, 2000, 'El comentario');
begin
  if me.role not in ('admin', 'director', 'secretary') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if a.status = 'pending' then
    update public.absences
    set status = 'received', received_by = me.id, received_by_name = me.full_name, received_at = now(), updated_at = now()
    where id = a.id;
    insert into public.absence_history (absence_id, school_id, actor_id, actor_name, action)
    values (a.id, a.school_id, me.id, me.full_name, 'received');
    perform private.notify(
      array[a.user_id], 'Tu ausencia fue recibida ✅',
      coalesce(me.full_name || ': ' || left(v_comment, 140), 'Confirmada por ' || me.full_name || '.'),
      '#/absence/' || a.id
    );
  elsif v_comment is not null then
    perform private.notify(
      array[a.user_id], 'Nuevo comentario de ' || me.full_name, left(v_comment, 140), '#/absence/' || a.id
    );
  end if;
  if v_comment is not null then
    insert into public.comments (absence_id, user_id, author_name, author_role, body)
    values (a.id, me.id, me.full_name, me.role, v_comment);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Daily maintenance: the "notify" Edge Function removes cancelled absences older than 15 days
-- (files included) and old delivery logs.
-- ---------------------------------------------------------------------------

alter table public.outbox drop constraint if exists outbox_kind_check;
alter table public.outbox add constraint outbox_kind_check check (kind in ('push', 'teams', 'maintenance'));

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'leap-daily-maintenance',
  '23 7 * * *',
  $job$insert into public.outbox (kind, payload) values ('maintenance', '{}'::jsonb)$job$
);

-- ---------------------------------------------------------------------------

revoke execute on function public.cancel_absence(bigint, text, text) from public, anon;
revoke execute on function
  public.update_absence(bigint, date, date, boolean, time, time, text, text, text, text, date) from public, anon;
revoke execute on function private.require_owner_or_admin(public.absences, public.profiles, text)
  from public, anon, authenticated;
grant execute on function
  public.cancel_absence(bigint, text, text),
  public.update_absence(bigint, date, date, boolean, time, time, text, text, text, text, date)
  to authenticated;

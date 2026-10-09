-- Cobertura por día: in an absence of several days, each person covers every day or only some (covers[].days),
-- with their own hours, e.g. José covers Monday 8:00-10:00 and Ana Tuesday. The same person can be on the list
-- more than once for different days (e.g. other hours on another day). Only whoever covers is told; the absent
-- person sees it in their absence, without a notice. If the absence's dates change, the days outside it go away.

-- Up to 40 rows: several people a day for a few weeks.
alter table public.absences drop constraint absences_covers_check;
alter table public.absences add constraint absences_covers_check
  check (jsonb_typeof(covers) = 'array' and jsonb_array_length(covers) <= 40);

-- Every coverage already saved is for every day.
update public.absences
set covers = (
  select jsonb_agg(e.value || jsonb_build_object('days', coalesce(e.value->'days', '[]'::jsonb)) order by e.ordinality)
  from jsonb_array_elements(covers) with ordinality e)
where covers <> '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- What each substitute is told
-- ---------------------------------------------------------------------------

/** One person on the list: their id, or the name of someone from outside. */
create or replace function private.cover_key(c jsonb)
returns text
language sql immutable set search_path = ''
as $$
  select coalesce(c->>'substitute_id', 'name:' || lower(btrim(c->>'name')))
$$;

/** "lun 12 oct, mar 13 oct" (their days), or the absence's dates. */
create or replace function private.cover_when(a public.absences, c jsonb)
returns text
language sql stable set search_path = ''
as $$
  select case when jsonb_array_length(coalesce(c->'days', '[]'::jsonb)) > 0
    then (select string_agg(private.fmt_date(d::date), ', ' order by d::date) from jsonb_array_elements_text(c->'days') d)
    else private.fmt_range(a.start_date, a.end_date) end
$$;

/**
 * Everything one person covers in an absence (one or more rows): their days, hours, groups and room, and the
 * instructions; never the type or the reason of the absence.
 */
create or replace function private.cover_notice_all(a public.absences, p_parts jsonb)
returns text
language sql stable set search_path = ''
as $$
  select concat_ws(' · ',
    (select string_agg(concat_ws(' · ',
        private.cover_when(a, e.value),
        private.cover_schedule(a, e.value),
        private.cover_where(array(select jsonb_array_elements_text(coalesce(e.value->'groups', '[]'::jsonb))), e.value->>'room')),
      '; ' order by e.ordinality)
     from jsonb_array_elements(p_parts) with ordinality e),
    case when a.coverage_notes is not null then 'Instrucciones: «' || private.short_text(a.coverage_notes, 160) || '»' end)
$$;

/** One row: the same as before, now with its days. */
create or replace function private.cover_notice(a public.absences, c jsonb)
returns text
language sql stable set search_path = ''
as $$
  select private.cover_notice_all(a, jsonb_build_array(c))
$$;

/** A person's rows in a list, without who assigned them and when (to compare). */
create or replace function private.cover_parts(p_covers jsonb, p_key text)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_agg(e.value - 'set_by_name' - 'set_at' order by e.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_covers) with ordinality e
  where private.cover_key(e.value) = p_key
$$;

/** The names on the list, each once, in order (absences.substitute: lists and "Sin cubrir"). */
create or replace function private.cover_names(p_covers jsonb)
returns text
language sql immutable set search_path = ''
as $$
  select left(string_agg(x.name, ', ' order by x.first), 300)
  from (select e.value->>'name' as name, min(e.ordinality) as first
        from jsonb_array_elements(p_covers) with ordinality e group by 1) x
$$;

-- ---------------------------------------------------------------------------
-- Assigning the coverage
-- ---------------------------------------------------------------------------

/**
 * Who covers: the whole list, in order (up to 40 rows). Each row: substitute_id (someone of the staff, who gets a
 * notice) or name (someone from outside), days (dates of the absence; empty = every day), groups (of the
 * school's calendar), room, and start_time / end_time (optional; by default the absence's hours). A person can
 * be on more than one row for different days. Whoever is new is told; whoever's days, groups, room or hours
 * changed is told again; whoever is no longer on it is told too. The absent person isn't told: it shows in their
 * absence. An empty list removes the coverage.
 */
create or replace function public.set_absence_covers(p_id bigint, p_covers jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_school text[];
  v_absent text;
  v_item jsonb;
  v_old jsonb;
  v_new jsonb := '[]'::jsonb;
  v_person public.profiles;
  v_sub text;
  v_groups text[];
  v_missing text;
  v_room text;
  v_start time;
  v_end time;
  v_days date[];
  v_key text;
  v_old_parts jsonb;
  v_new_parts jsonb;
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if p_covers is null or jsonb_typeof(p_covers) <> 'array' then
    raise exception 'La lista de cobertura no es válida.';
  end if;
  if jsonb_array_length(p_covers) > 40 then
    raise exception 'La cobertura puede tener hasta 40 filas.';
  end if;
  select x.groups into v_school from public.school_settings x where x.school_id = a.school_id;
  select full_name into v_absent from public.profiles where id = a.user_id;

  for v_item in select e.value from jsonb_array_elements(p_covers) e loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(coalesce(v_item->'days', '[]'::jsonb)) <> 'array' then
      raise exception 'La lista de cobertura no es válida.';
    end if;
    v_person := null;
    v_sub := private.clean_text(v_item->>'name', 300, 'El nombre de quien cubre');
    if nullif(v_item->>'substitute_id', '') is not null then
      select * into v_person from public.profiles p
      where p.id = (v_item->>'substitute_id')::uuid and p.school_id = a.school_id and p.active and p.role <> 'admin';
      if v_person.id is null then
        raise exception 'No se encontró a esa persona del personal.';
      end if;
      if v_person.id = a.user_id then
        raise exception 'Elige a otra persona: % es quien va a faltar.', v_person.full_name;
      end if;
      v_sub := v_person.full_name;
    elsif v_sub is null then
      raise exception 'Escribe el nombre de quien cubre.';
    end if;

    v_days := array(select distinct d::date from jsonb_array_elements_text(coalesce(v_item->'days', '[]'::jsonb)) d order by 1);
    if exists (select 1 from unnest(v_days) d where d < a.start_date or d > a.end_date) then
      raise exception 'Elige días de la ausencia para %.', v_sub;
    end if;

    v_groups := array(
      select distinct btrim(e.grp) from jsonb_array_elements_text(coalesce(v_item->'groups', '[]'::jsonb)) as e(grp)
      where btrim(e.grp) <> '');
    if cardinality(v_groups) > 20 then
      raise exception 'Elige hasta 20 grupos por persona.';
    end if;
    select e.grp into v_missing from unnest(v_groups) as e(grp) where not e.grp = any(coalesce(v_school, '{}')) limit 1;
    if v_missing is not null then
      raise exception 'El grupo % no está en el calendario escolar.', v_missing;
    end if;
    -- In the school's order.
    v_groups := array(
      select t.grp from unnest(v_school) with ordinality as t(grp, ord) where t.grp = any(v_groups) order by t.ord);

    v_room := private.clean_text(v_item->>'room', 40, 'El salón');
    v_start := nullif(v_item->>'start_time', '')::time;
    v_end := nullif(v_item->>'end_time', '')::time;
    if (v_start is null) <> (v_end is null) then
      raise exception 'Indica de qué hora a qué hora cubre %.', v_sub;
    end if;
    if v_end <= v_start then
      raise exception 'La hora final debe ser después de la inicial (%).', v_sub;
    end if;

    v_item := jsonb_build_object(
      'substitute_id', v_person.id, 'name', v_sub,
      'days', (select coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d), '[]'::jsonb) from unnest(v_days) d),
      'groups', to_jsonb(v_groups), 'room', v_room,
      'start_time', to_char(v_start, 'HH24:MI'), 'end_time', to_char(v_end, 'HH24:MI'));
    -- The same row as before (same person and days): who assigned it and when stay if nothing changed.
    select o.value into v_old from jsonb_array_elements(a.covers) o
    where (o.value - 'set_by_name' - 'set_at') = v_item
    limit 1;
    v_item := coalesce(v_old, v_item || jsonb_build_object('set_by_name', me.full_name, 'set_at', now()));
    v_new := v_new || jsonb_build_array(v_item);
  end loop;

  -- A person twice on the same day (or on every day and again on one).
  select e1.value->>'name' into v_sub
  from jsonb_array_elements(v_new) with ordinality e1
  join jsonb_array_elements(v_new) with ordinality e2
    on e1.ordinality < e2.ordinality and private.cover_key(e1.value) = private.cover_key(e2.value)
  where jsonb_array_length(e1.value->'days') = 0 or jsonb_array_length(e2.value->'days') = 0
     or exists (select 1 from jsonb_array_elements_text(e1.value->'days') x
                join jsonb_array_elements_text(e2.value->'days') y on y = x)
  limit 1;
  if v_sub is not null then
    raise exception '% está dos veces el mismo día.', v_sub;
  end if;

  if v_new = a.covers then
    return;
  end if;

  update public.absences
  set covers = v_new,
      substitute = private.cover_names(v_new),
      substitute_id = (v_new->0->>'substitute_id')::uuid,
      cover_groups = array(select jsonb_array_elements_text(coalesce(v_new->0->'groups', '[]'::jsonb))),
      cover_room = v_new->0->>'room',
      cover_set_by_name = (select e.value->>'set_by_name' from jsonb_array_elements(v_new) e
                           order by (e.value->>'set_at')::timestamptz desc limit 1),
      cover_set_at = (select max((e.value->>'set_at')::timestamptz) from jsonb_array_elements(v_new) e),
      updated_at = now()
  where id = a.id;

  -- One notice per person of the staff whose part changed, with everything they cover.
  for v_key in
    select distinct private.cover_key(e.value)
    from jsonb_array_elements(a.covers || v_new) e
    where e.value->>'substitute_id' is not null
  loop
    v_old_parts := private.cover_parts(a.covers, v_key);
    v_new_parts := private.cover_parts(v_new, v_key);
    continue when v_old_parts = v_new_parts;
    if v_new_parts = '[]'::jsonb then
      perform private.notify_tagged(
        private.cover_user(v_old_parts->0), 'Ya no cubres a ' || v_absent,
        private.fmt_range(a.start_date, a.end_date) || ' · lo cambió ' || me.full_name,
        '#/cover/' || a.id, 'cover-' || a.id, false
      );
    else
      perform private.notify_tagged(
        private.cover_user(v_new_parts->0),
        case when v_old_parts = '[]'::jsonb then '📋 Vas a cubrir a ' else '📋 Cambió tu cobertura de ' end || v_absent,
        private.cover_notice_all(a, v_new_parts), '#/cover/' || a.id, 'cover-' || a.id, false
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- When the absence changes
-- ---------------------------------------------------------------------------

/** New dates: the days that are no longer in the absence go away (and a row left without days too). */
create or replace function private.absence_cover_days()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.covers = '[]'::jsonb or (new.start_date, new.end_date) is not distinct from (old.start_date, old.end_date) then
    return new;
  end if;
  new.covers := coalesce((
    select jsonb_agg(jsonb_set(e.value, '{days}', coalesce((
        select jsonb_agg(d order by d) from jsonb_array_elements_text(e.value->'days') d
        where d::date between new.start_date and new.end_date), '[]'::jsonb))
      order by e.ordinality)
    from jsonb_array_elements(new.covers) with ordinality e
    where jsonb_array_length(coalesce(e.value->'days', '[]'::jsonb)) = 0
       or exists (select 1 from jsonb_array_elements_text(e.value->'days') d where d::date between new.start_date and new.end_date)
  ), '[]'::jsonb);
  new.substitute := private.cover_names(new.covers);
  new.substitute_id := (new.covers->0->>'substitute_id')::uuid;
  new.cover_groups := array(select jsonb_array_elements_text(coalesce(new.covers->0->'groups', '[]'::jsonb)));
  new.cover_room := new.covers->0->>'room';
  return new;
end;
$$;

create trigger absences_cover_days
  before update of start_date, end_date on public.absences
  for each row execute function private.absence_cover_days();

/**
 * Later changes reach the substitutes they affect, once each: a new date, hours or instructions, or the absence
 * cancelled. Whoever had only days that are no longer in the absence is told they don't cover anymore.
 */
create or replace function private.absence_notify_substitute()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_absent text;
  v_key text;
  v_parts jsonb;
  v_before jsonb;
begin
  if old.covers = '[]'::jsonb and new.covers = '[]'::jsonb then
    return null;
  end if;
  select full_name into v_absent from public.profiles where id = new.user_id;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    for v_key in select distinct private.cover_key(e.value) from jsonb_array_elements(old.covers) e
      where e.value->>'substitute_id' is not null loop
      perform private.notify_tagged(
        private.cover_user(private.cover_parts(old.covers, v_key)->0), 'Ya no tienes que cubrir a ' || v_absent,
        private.fmt_range(new.start_date, new.end_date) || ' · se canceló la ausencia',
        '#/cover/' || new.id, 'cover-' || new.id, false
      );
    end loop;
  elsif new.status <> 'cancelled'
    and (new.start_date, new.end_date, new.partial, new.start_time, new.end_time, new.coverage_notes)
      is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time, old.coverage_notes) then
    for v_key in select distinct private.cover_key(e.value) from jsonb_array_elements(old.covers || new.covers) e
      where e.value->>'substitute_id' is not null loop
      v_parts := private.cover_parts(new.covers, v_key);
      v_before := private.cover_parts(old.covers, v_key);
      if v_parts = '[]'::jsonb then
        perform private.notify_tagged(
          private.cover_user(v_before->0), 'Ya no cubres a ' || v_absent,
          private.fmt_range(new.start_date, new.end_date) || ' · cambiaron las fechas de la ausencia',
          '#/cover/' || new.id, 'cover-' || new.id, false
        );
      -- Only if what they were told changes (e.g. not whoever covers one day that stays the same).
      elsif private.cover_notice_all(old, v_before) is distinct from private.cover_notice_all(new, v_parts) then
        perform private.notify_tagged(
          private.cover_user(v_parts->0), '📋 Cambió tu cobertura de ' || v_absent, private.cover_notice_all(new, v_parts),
          '#/cover/' || new.id, 'cover-' || new.id, false
        );
      end if;
    end loop;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- What each substitute sees (Vas a cubrir)
-- ---------------------------------------------------------------------------

-- The new one returns the days too: the old one goes out of the API.
alter function public.my_coverages(date, bigint) set schema private;
alter function private.my_coverages(date, bigint) rename to my_coverages_before_days;
revoke execute on function private.my_coverages_before_days(date, bigint) from public, anon, authenticated;

/**
 * My coverages, one row per row of the list (a person can have more than one in an absence): from a date on (not
 * cancelled, with a day still to come), or every one of an absence by its id (also cancelled, to say so). Who,
 * when (cover_days: my days, null = every day of the absence), my groups, room and hours, the instructions, and
 * who else covers it; never the type or the reason of the absence.
 */
create or replace function public.my_coverages(p_from date default null, p_id bigint default null)
returns table (
  id bigint, employee_name text, employee_position text, employee_role text, start_date date, end_date date,
  partial boolean, start_time time, end_time time, status text, coverage_notes text, cover_groups text[],
  cover_room text, cover_set_by_name text, cover_set_at timestamptz, cover_start_time time, cover_end_time time,
  others jsonb, cover_days date[]
)
language sql stable security definer set search_path = ''
as $$
  select a.id, p.full_name, p.position, p.role, a.start_date, a.end_date, a.partial, a.start_time, a.end_time,
    a.status, a.coverage_notes,
    array(select jsonb_array_elements_text(coalesce(c.value->'groups', '[]'::jsonb))),
    c.value->>'room', c.value->>'set_by_name', (c.value->>'set_at')::timestamptz,
    (c.value->>'start_time')::time, (c.value->>'end_time')::time,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'name', o.value->'name', 'groups', o.value->'groups', 'start_time', o.value->'start_time',
        'end_time', o.value->'end_time', 'days', coalesce(o.value->'days', '[]'::jsonb)) order by o.ordinality), '[]'::jsonb)
      from jsonb_array_elements(a.covers) with ordinality o
      where o.value->>'substitute_id' is distinct from (select auth.uid())::text),
    nullif(array(select d::date from jsonb_array_elements_text(coalesce(c.value->'days', '[]'::jsonb)) d order by 1), '{}')
  from public.absences a
  join public.profiles p on p.id = a.user_id
  cross join lateral jsonb_array_elements(a.covers) with ordinality c
  where a.covers @> jsonb_build_array(jsonb_build_object('substitute_id', (select auth.uid())))
    and c.value->>'substitute_id' = (select auth.uid())::text
    and a.school_id = (select private.my_school_id())
    and (case when p_id is not null then a.id = p_id
              else a.status <> 'cancelled' and a.end_date >= coalesce(p_from, current_date)
                and (jsonb_array_length(coalesce(c.value->'days', '[]'::jsonb)) = 0
                     or exists (select 1 from jsonb_array_elements_text(c.value->'days') d
                                where d::date >= coalesce(p_from, current_date))) end)
  order by coalesce((select min(d::date) from jsonb_array_elements_text(coalesce(c.value->'days', '[]'::jsonb)) d), a.start_date),
    coalesce((c.value->>'start_time')::time, a.start_time) nulls first, a.id, c.ordinality
  limit 200
$$;

revoke execute on function private.cover_key(jsonb), private.cover_when(public.absences, jsonb),
  private.cover_notice_all(public.absences, jsonb), private.cover_parts(jsonb, text), private.cover_names(jsonb),
  private.absence_cover_days() from public, anon, authenticated;
revoke execute on function public.my_coverages(date, bigint) from public, anon;
grant execute on function public.my_coverages(date, bigint) to authenticated;

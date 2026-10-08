-- Cobertura: more than one person can cover an absence, each with their own grades and groups, room and
-- (optional) hours, e.g. José takes 7-A from 8:00 to 9:00 and Ana takes 7-B. Each one gets their own notice.
-- absences.covers keeps the list; absences.substitute keeps the names (lists and "Sin cubrir"), and
-- substitute_id / cover_groups / cover_room / cover_set_* keep the first one, for an older app still open.

alter table public.absences
  add column covers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(covers) = 'array' and jsonb_array_length(covers) <= 10);
create index absences_covers on public.absences using gin (covers jsonb_path_ops);

-- The coverages there are.
update public.absences
set covers = jsonb_build_array(jsonb_build_object(
  'substitute_id', substitute_id, 'name', substitute, 'groups', to_jsonb(cover_groups), 'room', cover_room,
  'start_time', null, 'end_time', null, 'set_by_name', cover_set_by_name, 'set_at', coalesce(cover_set_at, updated_at)))
where substitute is not null;

-- Same as before, plus the list.
create or replace view public.absences_v with (security_invoker = true) as
select
  a.id, a.school_id, a.user_id, a.created_by, a.created_by_name, a.start_date, a.end_date, a.partial, a.start_time,
  a.end_time, a.category, a.reason, a.coverage_notes, a.status, a.received_by, a.received_by_name, a.received_at,
  a.substitute, a.cancelled_at, a.created_at, a.updated_at,
  p.full_name as employee_name,
  p.position as employee_position,
  p.role as employee_role,
  (select count(*) from public.attachments t where t.absence_id = a.id)::integer as attachment_count,
  (select count(*) from public.comments c where c.absence_id = a.id)::integer as comment_count,
  a.substitute_id, a.cover_groups, a.cover_room, a.cover_set_by_name, a.cover_set_at,
  p.room as employee_room,
  p.groups as employee_groups,
  a.covers
from public.absences a
join public.profiles p on p.id = a.user_id;

-- ---------------------------------------------------------------------------
-- What each substitute is told
-- ---------------------------------------------------------------------------

/** The hours of one coverage: their own, or the absence's. */
create or replace function private.cover_schedule(a public.absences, c jsonb)
returns text
language sql stable set search_path = ''
as $$
  select case when c->>'start_time' is not null
    then private.fmt_schedule(true, (c->>'start_time')::time, (c->>'end_time')::time)
    else private.fmt_schedule(a.partial, a.start_time, a.end_time) end
$$;

/** When, their hours, their groups and room, and the instructions; never the type or the reason of the absence. */
create or replace function private.cover_notice(a public.absences, c jsonb)
returns text
language sql stable set search_path = ''
as $$
  select concat_ws(' · ',
    private.fmt_range(a.start_date, a.end_date),
    private.cover_schedule(a, c),
    private.cover_where(array(select jsonb_array_elements_text(coalesce(c->'groups', '[]'::jsonb))), c->>'room'),
    case when a.coverage_notes is not null then 'Instrucciones: «' || private.short_text(a.coverage_notes, 160) || '»' end)
$$;

/** A substitute who is still in the school (the list keeps the id even if the person was removed). */
create or replace function private.cover_user(c jsonb)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select array(select p.id from public.profiles p where p.id = (c->>'substitute_id')::uuid)
$$;

-- ---------------------------------------------------------------------------
-- Assigning the coverage
-- ---------------------------------------------------------------------------

/**
 * Who covers: the whole list, in order (up to 10). Each item: substitute_id (someone of the staff, who gets a
 * notice) or name (someone from outside), groups (of the school's calendar), room, and start_time / end_time
 * (optional; by default the absence's hours). Whoever is new is told; whoever's groups, room or hours changed
 * is told again; whoever is no longer on it is told too. An empty list removes the coverage.
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
  v_ids uuid[] := '{}';
  v_sub text;
  v_groups text[];
  v_missing text;
  v_room text;
  v_start time;
  v_end time;
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
  if jsonb_array_length(p_covers) > 10 then
    raise exception 'Elige hasta 10 personas para cubrir.';
  end if;
  select x.groups into v_school from public.school_settings x where x.school_id = a.school_id;
  select full_name into v_absent from public.profiles where id = a.user_id;

  for v_item in select e.value from jsonb_array_elements(p_covers) e loop
    if jsonb_typeof(v_item) <> 'object' then
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
      if v_person.id = any(v_ids) then
        raise exception '% está dos veces en la cobertura.', v_person.full_name;
      end if;
      v_ids := v_ids || v_person.id;
      v_sub := v_person.full_name;
    elsif v_sub is null then
      raise exception 'Escribe el nombre de quien cubre.';
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
      'substitute_id', v_person.id, 'name', v_sub, 'groups', to_jsonb(v_groups), 'room', v_room,
      'start_time', to_char(v_start, 'HH24:MI'), 'end_time', to_char(v_end, 'HH24:MI'));
    -- The same person as before (by id, or by name if from outside).
    select o.value into v_old from jsonb_array_elements(a.covers) o
    where case when v_person.id is not null then o.value->>'substitute_id' = v_person.id::text
               else o.value->>'substitute_id' is null and o.value->>'name' = v_sub end
    limit 1;
    if v_old is not null and (v_old - 'set_by_name' - 'set_at') = v_item then
      -- Nothing changed for them: who assigned it and when stay.
      v_item := v_old;
    else
      v_item := v_item || jsonb_build_object('set_by_name', me.full_name, 'set_at', now());
      if v_person.id is not null then
        perform private.notify_tagged(
          array[v_person.id],
          case when v_old is null then '📋 Vas a cubrir a ' || v_absent else '📋 Cambió tu cobertura de ' || v_absent end,
          private.cover_notice(a, v_item), '#/cover/' || a.id, 'cover-' || a.id, false
        );
      end if;
    end if;
    v_new := v_new || jsonb_build_array(v_item);
  end loop;

  if v_new = a.covers then
    return;
  end if;

  -- Whoever is no longer on it.
  for v_old in select o.value from jsonb_array_elements(a.covers) o
    where o.value->>'substitute_id' is not null and not (o.value->>'substitute_id')::uuid = any(v_ids) loop
    perform private.notify_tagged(
      private.cover_user(v_old), 'Ya no cubres a ' || v_absent,
      private.fmt_range(a.start_date, a.end_date) || ' · lo cambió ' || me.full_name,
      '#/cover/' || a.id, 'cover-' || a.id, false
    );
  end loop;

  update public.absences
  set covers = v_new,
      substitute = (select left(string_agg(e.value->>'name', ', ' order by e.ordinality), 300)
                    from jsonb_array_elements(v_new) with ordinality e),
      substitute_id = (v_new->0->>'substitute_id')::uuid,
      cover_groups = array(select jsonb_array_elements_text(coalesce(v_new->0->'groups', '[]'::jsonb))),
      cover_room = v_new->0->>'room',
      cover_set_by_name = (select e.value->>'set_by_name' from jsonb_array_elements(v_new) e
                           order by (e.value->>'set_at')::timestamptz desc limit 1),
      cover_set_at = (select max((e.value->>'set_at')::timestamptz) from jsonb_array_elements(v_new) e),
      updated_at = now()
  where id = a.id;

  -- The absent person, when who covers changes.
  if jsonb_array_length(v_new) > 0
    and (select array_agg(e.value->>'name' order by e.value->>'name') from jsonb_array_elements(v_new) e)
      is distinct from (select array_agg(e.value->>'name' order by e.value->>'name') from jsonb_array_elements(a.covers) e) then
    perform private.notify(
      array[a.user_id],
      case when a.covers = '[]'::jsonb then 'Se asignó cobertura para tu ausencia' else 'Cambió la cobertura de tu ausencia' end,
      (select string_agg(e.value->>'name', ', ' order by e.ordinality) from jsonb_array_elements(v_new) with ordinality e)
        || ' (por ' || me.full_name || ')',
      '#/absence/' || a.id
    );
  end if;
end;
$$;

/** The app before several people per absence: one person, or nobody. */
create or replace function public.set_coverage(
  p_id bigint,
  p_substitute text default null,
  p_substitute_id uuid default null,
  p_groups text[] default null,
  p_room text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.set_absence_covers(p_id, case
    when p_substitute_id is null and nullif(btrim(coalesce(p_substitute, '')), '') is null then '[]'::jsonb
    else jsonb_build_array(jsonb_build_object(
      'substitute_id', p_substitute_id, 'name', p_substitute, 'groups', to_jsonb(coalesce(p_groups, '{}')), 'room', p_room))
  end);
end;
$$;

/** Later changes reach every substitute: a new date, hours or instructions, or the absence cancelled. */
create or replace function private.absence_notify_substitute()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_absent text;
  v_item jsonb;
begin
  if new.covers = '[]'::jsonb then
    return null;
  end if;
  select full_name into v_absent from public.profiles where id = new.user_id;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    for v_item in select e.value from jsonb_array_elements(new.covers) e where e.value->>'substitute_id' is not null loop
      perform private.notify_tagged(
        private.cover_user(v_item), 'Ya no tienes que cubrir a ' || v_absent,
        private.fmt_range(new.start_date, new.end_date) || ' · se canceló la ausencia',
        '#/cover/' || new.id, 'cover-' || new.id, false
      );
    end loop;
  elsif new.status <> 'cancelled'
    and (new.start_date, new.end_date, new.partial, new.start_time, new.end_time, new.coverage_notes)
      is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time, old.coverage_notes) then
    for v_item in select e.value from jsonb_array_elements(new.covers) e where e.value->>'substitute_id' is not null loop
      perform private.notify_tagged(
        private.cover_user(v_item), '📋 Cambió tu cobertura de ' || v_absent, private.cover_notice(new, v_item),
        '#/cover/' || new.id, 'cover-' || new.id, false
      );
    end loop;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- What each substitute sees (Vas a cubrir)
-- ---------------------------------------------------------------------------

-- The new one returns more columns: the old one goes out of the API.
alter function public.my_coverages(date, bigint) set schema private;
alter function private.my_coverages(date, bigint) rename to my_coverages_one_person;
revoke execute on function private.my_coverages_one_person(date, bigint) from public, anon, authenticated;

/**
 * My coverages: from a date on (not cancelled), or one by absence id (also cancelled, to say so). Who, when,
 * my groups, room and hours, the instructions, and who else covers it (name, groups, hours); never the type or
 * the reason of the absence.
 */
create or replace function public.my_coverages(p_from date default null, p_id bigint default null)
returns table (
  id bigint, employee_name text, employee_position text, employee_role text, start_date date, end_date date,
  partial boolean, start_time time, end_time time, status text, coverage_notes text, cover_groups text[],
  cover_room text, cover_set_by_name text, cover_set_at timestamptz, cover_start_time time, cover_end_time time,
  others jsonb
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
        'end_time', o.value->'end_time') order by o.ordinality), '[]'::jsonb)
      from jsonb_array_elements(a.covers) with ordinality o
      where o.value->>'substitute_id' is distinct from (select auth.uid())::text)
  from public.absences a
  join public.profiles p on p.id = a.user_id
  cross join lateral jsonb_array_elements(a.covers) c
  where a.covers @> jsonb_build_array(jsonb_build_object('substitute_id', (select auth.uid())))
    and c.value->>'substitute_id' = (select auth.uid())::text
    and a.school_id = (select private.my_school_id())
    and (case when p_id is not null then a.id = p_id
              else a.status <> 'cancelled' and a.end_date >= coalesce(p_from, current_date) end)
  order by a.start_date, coalesce((c.value->>'start_time')::time, a.start_time) nulls first, a.id
  limit 100
$$;

revoke execute on function private.cover_schedule(public.absences, jsonb), private.cover_notice(public.absences, jsonb),
  private.cover_user(jsonb) from public, anon, authenticated;
revoke execute on function
  public.set_absence_covers(bigint, jsonb),
  public.my_coverages(date, bigint)
  from public, anon;
grant execute on function
  public.set_absence_covers(bigint, jsonb),
  public.my_coverages(date, bigint)
  to authenticated;

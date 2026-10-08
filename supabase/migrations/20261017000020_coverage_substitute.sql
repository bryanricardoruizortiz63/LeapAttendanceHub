-- Cobertura: who covers an absence is someone of the staff (or just a name, for someone from outside), with the
-- grades and groups and the room to cover.
--   * The substitute gets a notice (app and push) with the days, the hours, the groups, the room and the
--     instructions the absent person left. Never the type or the reason of the absence.
--   * They see it in the app (Vas a cubrir), and hear about it again when the absence changes date, hours or
--     instructions, when it's cancelled, and when the coverage goes to someone else.

alter table public.absences
  add column substitute_id uuid references public.profiles on delete set null,
  add column cover_groups text[] not null default '{}' check (cardinality(cover_groups) <= 20),
  add column cover_room text check (char_length(cover_room) <= 40),
  add column cover_set_by_name text,
  add column cover_set_at timestamptz;
create index absences_substitute on public.absences (substitute_id) where substitute_id is not null;

-- Same as before, plus the coverage and the absent person's room and groups (to suggest them).
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
  p.groups as employee_groups
from public.absences a
join public.profiles p on p.id = a.user_id;

-- ---------------------------------------------------------------------------
-- What the substitute is told
-- ---------------------------------------------------------------------------

/** "Grupos 7-A, 7-B · Salón 204" (whatever there is), or null. */
create or replace function private.cover_where(p_groups text[], p_room text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(concat_ws(' · ',
    case when cardinality(p_groups) = 1 then 'Grupo ' || p_groups[1]
         when cardinality(p_groups) > 1 then 'Grupos ' || array_to_string(p_groups, ', ') end,
    case when p_room is not null then 'Salón ' || p_room end), '')
$$;

/** When, where and the instructions; never the type or the reason of the absence. */
create or replace function private.cover_text(a public.absences)
returns text
language sql stable set search_path = ''
as $$
  select concat_ws(' · ',
    private.fmt_range(a.start_date, a.end_date),
    private.fmt_schedule(a.partial, a.start_time, a.end_time),
    private.cover_where(a.cover_groups, a.cover_room),
    case when a.coverage_notes is not null then 'Instrucciones: «' || private.short_text(a.coverage_notes, 160) || '»' end)
$$;

-- ---------------------------------------------------------------------------
-- Assigning the coverage
-- ---------------------------------------------------------------------------

-- The two-argument version would make calls with (p_id, p_substitute) ambiguous: out of the API.
alter function public.set_coverage(bigint, text) set schema private;
alter function private.set_coverage(bigint, text) rename to set_coverage_before_substitutes;
revoke execute on function private.set_coverage_before_substitutes(bigint, text) from public, anon, authenticated;

/**
 * Who covers: p_substitute_id for someone of the staff (they get the notice), or only p_substitute for someone
 * from outside. p_groups: grades and groups of the school's calendar; p_room: optional. Nobody (both null)
 * removes the coverage.
 */
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
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  s public.profiles;
  b public.absences;
  v_sub text := private.clean_text(p_substitute, 300, 'La cobertura');
  v_room text := private.clean_text(p_room, 40, 'El salón');
  v_groups text[] := array(select distinct btrim(g) from unnest(coalesce(p_groups, '{}')) g where btrim(g) <> '');
  v_school text[];
  v_missing text;
  v_name text;
begin
  if not private.can(me, 'absences') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if p_substitute_id is not null then
    select * into s from public.profiles
    where id = p_substitute_id and school_id = a.school_id and active and role <> 'admin';
    if s.id is null then
      raise exception 'No se encontró a esa persona del personal.';
    end if;
    if s.id = a.user_id then
      raise exception 'Elige a otra persona: es quien va a faltar.';
    end if;
    v_sub := s.full_name;
  end if;

  if v_sub is null then
    v_groups := '{}';
    v_room := null;
  else
    if cardinality(v_groups) > 20 then
      raise exception 'Elige hasta 20 grupos.';
    end if;
    select x.groups into v_school from public.school_settings x where x.school_id = a.school_id;
    select g into v_missing from unnest(v_groups) g where not g = any(coalesce(v_school, '{}')) limit 1;
    if v_missing is not null then
      raise exception 'El grupo % no está en el calendario escolar.', v_missing;
    end if;
    -- In the school's order.
    v_groups := array(select g from unnest(v_school) with ordinality as t(g, n) where g = any(v_groups) order by n);
  end if;

  if (v_sub, s.id, v_groups, v_room) is not distinct from (a.substitute, a.substitute_id, a.cover_groups, a.cover_room) then
    return;
  end if;

  update public.absences
  set substitute = v_sub, substitute_id = s.id, cover_groups = v_groups, cover_room = v_room,
      cover_set_by_name = case when v_sub is null then null else me.full_name end,
      cover_set_at = case when v_sub is null then null else now() end,
      updated_at = now()
  where id = a.id
  returning * into b;

  select full_name into v_name from public.profiles where id = a.user_id;
  if v_sub is not null and v_sub is distinct from a.substitute then
    perform private.notify(
      array[a.user_id], 'Se asignó cobertura para tu ausencia', v_sub || ' (por ' || me.full_name || ')',
      '#/absence/' || a.id
    );
  end if;
  -- Whoever stops covering it.
  if a.substitute_id is not null and a.substitute_id is distinct from b.substitute_id then
    perform private.notify_tagged(
      array[a.substitute_id], 'Ya no cubres a ' || v_name,
      private.fmt_range(a.start_date, a.end_date) || ' · lo cambió ' || me.full_name,
      '#/cover/' || a.id, 'cover-' || a.id, false
    );
  end if;
  -- The substitute: everything they need to know.
  if b.substitute_id is not null then
    perform private.notify_tagged(
      array[b.substitute_id],
      case when b.substitute_id is distinct from a.substitute_id
        then '📋 Vas a cubrir a ' || v_name else '📋 Cambió tu cobertura de ' || v_name end,
      private.cover_text(b), '#/cover/' || a.id, 'cover-' || a.id, false
    );
  end if;
end;
$$;

/** Later changes reach the substitute too: a new date, hours or instructions, or the absence cancelled. */
create or replace function private.absence_notify_substitute()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
begin
  -- set_coverage already tells them when the coverage itself changes.
  if new.substitute_id is null or new.substitute_id is distinct from old.substitute_id then
    return null;
  end if;
  select full_name into v_name from public.profiles where id = new.user_id;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform private.notify_tagged(
      array[new.substitute_id], 'Ya no tienes que cubrir a ' || v_name,
      private.fmt_range(new.start_date, new.end_date) || ' · se canceló la ausencia',
      '#/cover/' || new.id, 'cover-' || new.id, false
    );
  elsif new.status <> 'cancelled'
    and (new.start_date, new.end_date, new.partial, new.start_time, new.end_time, new.coverage_notes)
      is distinct from (old.start_date, old.end_date, old.partial, old.start_time, old.end_time, old.coverage_notes) then
    perform private.notify_tagged(
      array[new.substitute_id], '📋 Cambió tu cobertura de ' || v_name, private.cover_text(new),
      '#/cover/' || new.id, 'cover-' || new.id, false
    );
  end if;
  return null;
end;
$$;

create trigger absences_notify_substitute
  after update of status, start_date, end_date, partial, start_time, end_time, coverage_notes on public.absences
  for each row execute function private.absence_notify_substitute();

-- ---------------------------------------------------------------------------
-- What the substitute sees (Vas a cubrir)
-- ---------------------------------------------------------------------------

/**
 * My coverages: from a date on (not cancelled), or one by id (also cancelled, to say so). Who, when, groups,
 * room and instructions; never the type or the reason of the absence.
 */
create or replace function public.my_coverages(p_from date default null, p_id bigint default null)
returns table (
  id bigint, employee_name text, employee_position text, employee_role text, start_date date, end_date date,
  partial boolean, start_time time, end_time time, status text, coverage_notes text, cover_groups text[],
  cover_room text, cover_set_by_name text, cover_set_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select a.id, p.full_name, p.position, p.role, a.start_date, a.end_date, a.partial, a.start_time, a.end_time,
    a.status, a.coverage_notes, a.cover_groups, a.cover_room, a.cover_set_by_name, a.cover_set_at
  from public.absences a
  join public.profiles p on p.id = a.user_id
  where a.substitute_id = (select auth.uid())
    and a.school_id = (select private.my_school_id())
    and (case when p_id is not null then a.id = p_id
              else a.status <> 'cancelled' and a.end_date >= coalesce(p_from, current_date) end)
  order by a.start_date, a.start_time nulls first, a.id
  limit 100
$$;

revoke execute on function private.cover_where(text[], text), private.cover_text(public.absences),
  private.absence_notify_substitute() from public, anon, authenticated;
revoke execute on function
  public.set_coverage(bigint, text, uuid, text[], text),
  public.my_coverages(date, bigint)
  from public, anon;
grant execute on function
  public.set_coverage(bigint, text, uuid, text[], text),
  public.my_coverages(date, bigint)
  to authenticated;

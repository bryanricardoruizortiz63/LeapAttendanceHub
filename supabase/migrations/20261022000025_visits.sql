-- Visitas: a parent (or anyone from outside) arrives and asks for someone.
--   * Whoever has the new "visitors" permission (Seguridad, Secretaría, the dirección and Administración by default;
--     the Administración account can give it to any role in Roles y permisos) notes it in Turnos: who came, for
--     which student (optional), whether they have an appointment, whom they're looking for (a service such as
--     Trabajo Social, or one person of the staff), where they're waiting and what it's about.
--   * The person (or everyone who attends the service) gets the notice at once, with alarm, and answers:
--     "Voy en camino" (to where the parent is waiting), "Que pase a mi oficina" (or another place), "Que espere"
--     (a few minutes) or something else. Whoever noted it hears the answer. The answer can be changed.
--   * Either side closes it: "Atendido", or "Se fue" when the visit didn't happen.
-- Visits are kept a year (the notify Edge Function deletes older ones); their notices, 24 hours.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'visitors', 'maintenance']::text[]);

-- Whoever receives the parents today: Seguridad, Secretaría and the dirección.
update public.school_roles set permissions = permissions || 'visitors'::text
where not 'visitors' = any(permissions) and ('security' = any(permissions) or key in ('admin', 'director', 'secretary', 'seguridad'));

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'visitors', 'maintenance'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'live', 'calendar', 'security', 'visitors'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'live', 'calendar', 'security', 'visitors'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'seguridad', 'Seguridad', array['security', 'visitors'], false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Visits
-- ---------------------------------------------------------------------------

create table public.visits (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  -- Who came (e.g. "Ana Ruiz, mamá") and for which student (free text, optional).
  visitor_name text not null check (char_length(visitor_name) between 2 and 100),
  student text check (char_length(student) <= 120),
  -- Whom they're looking for: a service (everyone who attends it) or one person. target_name keeps the name
  -- (of the person or the service) as it was.
  service_id bigint references public.school_services on delete set null,
  target_id uuid references public.profiles on delete set null,
  target_name text not null,
  -- Citado: the school gave them an appointment.
  appointment boolean not null,
  -- Where they're waiting (Seguridad, Dirección…) and what it's about.
  place text not null check (char_length(place) between 1 and 60),
  note text check (char_length(note) <= 300),
  -- waiting: nobody answered · answered · done (attended) · cancelled (they left, or it was a mistake)
  status text not null default 'waiting' check (status in ('waiting', 'answered', 'done', 'cancelled')),
  -- on_the_way: goes to where they're waiting · come: they go to answer_place · wait: answer_note says how long ·
  -- other: answer_note says what.
  answer text check (answer in ('on_the_way', 'come', 'wait', 'other')),
  answer_place text check (char_length(answer_place) <= 60),
  answer_note text check (char_length(answer_note) <= 200),
  answered_by uuid references public.profiles on delete set null,
  answered_by_name text,
  answered_at timestamptz,
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by_name text
);
create index visits_school on public.visits (school_id, created_at desc);
create index visits_target on public.visits (target_id, created_at desc) where target_id is not null;
create index visits_service on public.visits (service_id, created_at desc) where service_id is not null;

-- Whoever receives visits, whoever noted it, and whom it's for (the person, or whoever attends the service).
alter table public.visits enable row level security;
create policy "Ver visitas" on public.visits for select to authenticated
  using (school_id = (select private.my_school_id()) and (
    (select private.has_perm('visitors'))
    or created_by = (select auth.uid())
    or target_id = (select auth.uid())
    or (service_id is not null and private.serves(service_id))));

revoke insert, update, delete, truncate on public.visits from anon, authenticated;
revoke all on public.visits from anon;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

/** The people a visit is for: the person, or everyone who attends the service. */
create or replace function private.visit_ids(v public.visits, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select case
    when v.target_id is not null then array_remove(array[v.target_id], p_exclude)
    when v.service_id is not null then private.service_staff_ids(v.service_id, p_exclude)
    else '{}'::uuid[] end
$$;

/** Whether this person is whom the visit is for. */
create or replace function private.visit_is_for(v public.visits, me public.profiles)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(v.target_id = me.id, false) or (v.service_id is not null and exists (
    select 1 from public.school_services s where s.id = v.service_id and me.role = any(s.roles)))
$$;

/** "Ana Ruiz (mamá de José, 5-B)" for the notices. */
create or replace function private.visit_who(v public.visits)
returns text
language sql immutable set search_path = ''
as $$
  select v.visitor_name || coalesce(' (' || v.student || ')', '')
$$;

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

/**
 * For the form: the active services (with who is available) and the staff, without the Administración
 * account or the person asking.
 */
create or replace function public.visit_targets()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not private.can(me, 'visitors') then raise exception 'No tienes permiso para avisar visitas.'; end if;
  return jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name,
          'staff', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'name', p.full_name, 'status', private.staff_status(st),
                'until', case when private.staff_status(st) <> 'available' then st.until end)
              order by p.full_name), '[]'::jsonb)
            from public.profiles p
            left join public.service_staff_status st on st.user_id = p.id
            where p.school_id = s.school_id and p.active and p.role = any(s.roles)))
        order by s.position, s.name)
      from public.school_services s
      where s.school_id = me.school_id and s.active
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.full_name, 'position', p.position, 'room', p.room,
          'role', (select r.name from public.school_roles r where r.school_id = p.school_id and r.key = p.role))
        order by p.full_name)
      from public.profiles p
      where p.school_id = me.school_id and p.active and p.role <> 'admin' and p.id <> me.id
    ), '[]'::jsonb)
  );
end;
$$;

/** Notes a visit and tells whom it's for. One of p_service_id or p_target_id. */
create or replace function public.create_visit(
  p_visitor text, p_student text, p_service_id bigint, p_target_id uuid, p_appointment boolean, p_place text, p_note text
)
returns public.visits
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v public.visits;
  s public.school_services;
  t public.profiles;
  v_visitor text := private.clean_text(regexp_replace(coalesce(p_visitor, ''), '\s+', ' ', 'g'), 100, 'El nombre de quien llegó');
  v_student text := private.clean_text(regexp_replace(coalesce(p_student, ''), '\s+', ' ', 'g'), 120, 'El estudiante');
  v_place text := private.clean_text(regexp_replace(coalesce(p_place, ''), '\s+', ' ', 'g'), 60, 'El lugar');
  v_note text := private.clean_text(p_note, 300, 'El asunto');
  v_ids uuid[];
begin
  if not private.can(me, 'visitors') then raise exception 'No tienes permiso para avisar visitas.'; end if;
  if v_visitor is null or char_length(v_visitor) < 2 then raise exception 'Escribe quién llegó.'; end if;
  if p_appointment is null then raise exception 'Elige si está citado.'; end if;
  if v_place is null then raise exception 'Escribe dónde espera.'; end if;
  if (p_service_id is null) = (p_target_id is null) then raise exception 'Elige a quién busca.'; end if;
  if (select count(*) from public.visits x where x.created_by = me.id and x.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Anotaste muchas visitas en la última hora. Espera un poco.';
  end if;
  if p_service_id is not null then
    select * into s from public.school_services x where x.id = p_service_id and x.school_id = me.school_id and x.active;
    if s.id is null then raise exception 'Ese servicio no está disponible.'; end if;
    if cardinality(private.service_staff_ids(s.id, me.id)) = 0 then
      raise exception 'Nadie más atiende % ahora. Busca a otra persona.', s.name;
    end if;
  else
    select * into t from public.profiles x
    where x.id = p_target_id and x.school_id = me.school_id and x.active and x.role <> 'admin';
    if t.id is null then raise exception 'No se encontró a esa persona.'; end if;
    if t.id = me.id then raise exception 'La visita es para ti: no hace falta avisarte.'; end if;
  end if;

  insert into public.visits (
    school_id, visitor_name, student, service_id, target_id, target_name, appointment, place, note, created_by, created_by_name
  ) values (
    me.school_id, v_visitor, v_student, s.id, t.id, coalesce(s.name, t.full_name), p_appointment, v_place, v_note, me.id, me.full_name
  )
  returning * into v;
  v_ids := private.visit_ids(v, me.id);
  perform private.notify_tagged(v_ids,
    format('🚪 Te buscan: %s', private.visit_who(v)),
    concat_ws(' · ',
      case when s.id is not null then 'Para ' || s.name end,
      case when p_appointment then 'Está citado' else 'Sin cita' end,
      'espera en ' || v_place, v_note, 'avisó ' || me.full_name)
      || '. Responde si vas o si pasa a tu oficina.',
    '#/turns/visit/' || v.id, 'visit-' || v.id, true);
  return v;
end;
$$;

/**
 * The answer of whom the visit is for: on_the_way (to where they're waiting) · come (p_place: where they go) ·
 * wait (p_note: how long, optional) · other (p_note: what). It can be changed until the visit is closed.
 */
create or replace function public.answer_visit(p_id bigint, p_answer text, p_place text default null, p_note text default null)
returns public.visits
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v public.visits;
  v_place text := private.clean_text(regexp_replace(coalesce(p_place, ''), '\s+', ' ', 'g'), 60, 'El lugar');
  v_note text := private.clean_text(p_note, 200, 'La respuesta');
  v_link text := '#/turns/visit/' || p_id;
  v_title text;
  v_body text;
begin
  select * into v from public.visits x where x.id = p_id and x.school_id = me.school_id for update;
  if v.id is null or not (private.visit_is_for(v, me) or private.can(me, 'visitors') or v.created_by = me.id) then
    raise exception 'No se encontró la visita.';
  end if;
  if not private.visit_is_for(v, me) then raise exception 'Solo responde a quien buscan.'; end if;
  if v.status in ('done', 'cancelled') then
    raise exception 'Esta visita ya se cerró (%).', case v.status when 'done' then 'atendida' else 'se fue' end;
  end if;
  if p_answer is null or p_answer not in ('on_the_way', 'come', 'wait', 'other') then raise exception 'Elige qué responder.'; end if;
  if p_answer = 'come' and v_place is null then raise exception 'Escribe a dónde pasa.'; end if;
  if p_answer = 'other' and v_note is null then raise exception 'Escribe tu respuesta.'; end if;

  update public.visits
  set status = 'answered', answer = p_answer,
    answer_place = case when p_answer = 'come' then v_place end,
    answer_note = case when p_answer in ('wait', 'other') then v_note end,
    answered_by = me.id, answered_by_name = me.full_name, answered_at = now()
  where id = v.id
  returning * into v;

  v_title := case p_answer
    when 'on_the_way' then format('🚶 %s va a %s', me.full_name, v.place)
    when 'come' then format('👉 Que pase a %s', v.answer_place)
    when 'wait' then 'Que espere' || coalesce(' ' || v.answer_note, ' un momento')
    else format('💬 %s respondió', me.full_name) end;
  v_body := case p_answer
    when 'on_the_way' then format('Por %s. Que espere en %s.', private.visit_who(v), v.place)
    when 'come' then format('%s recibe a %s.', me.full_name, private.visit_who(v))
    when 'wait' then format('%s atiende a %s en un momento.', me.full_name, private.visit_who(v))
    else format('«%s» · visita de %s.', v.answer_note, private.visit_who(v)) end;
  if p_answer = 'wait' then v_title := '⏳ ' || v_title; end if;

  -- Seen by whom it's for; whoever noted it hears the answer, and the rest of the service that someone answered.
  perform private.close_notifications(v_link);
  perform private.notify_tagged(array_remove(array[v.created_by], me.id), v_title, v_body, v_link, 'visit-' || v.id, false);
  if v.service_id is not null then
    perform private.notify_tagged(private.uuid_minus(private.visit_ids(v, me.id), array[v.created_by]),
      format('%s ya respondió a %s', me.full_name, v.visitor_name), 'No hace falta que vaya nadie más.',
      v_link, 'visit-' || v.id, false);
  end if;
  return v;
end;
$$;

/** done: attended (whom it's for, whoever noted it or receives visits) · cancelled: they left, or it was a mistake. */
create or replace function public.close_visit(p_id bigint, p_status text)
returns public.visits
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v public.visits;
  v_link text := '#/turns/visit/' || p_id;
  v_for boolean;
begin
  select * into v from public.visits x where x.id = p_id and x.school_id = me.school_id for update;
  v_for := private.visit_is_for(v, me);
  if v.id is null or not (v_for or private.can(me, 'visitors') or v.created_by = me.id) then
    raise exception 'No se encontró la visita.';
  end if;
  if p_status is null or p_status not in ('done', 'cancelled') then raise exception 'Paso no válido.'; end if;
  if v.status in ('done', 'cancelled') then return v; end if;
  update public.visits set status = p_status, closed_at = now(), closed_by_name = me.full_name
  where id = v.id returning * into v;
  perform private.close_notifications(v_link);
  -- Whom it was for doesn't keep waiting for someone who left.
  if p_status = 'cancelled' and not v_for then
    perform private.notify_tagged(private.visit_ids(v, me.id),
      format('Ya no te buscan: %s', v.visitor_name), format('Se fue o se canceló · avisó %s.', me.full_name),
      v_link, 'visit-' || v.id, false);
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.visit_ids(public.visits, uuid), private.visit_is_for(public.visits, public.profiles), private.visit_who(public.visits)
  from public, anon, authenticated;

revoke execute on function
  public.visit_targets(),
  public.create_visit(text, text, bigint, uuid, boolean, text, text),
  public.answer_visit(bigint, text, text, text),
  public.close_visit(bigint, text)
  from public, anon;
grant execute on function
  public.visit_targets(),
  public.create_visit(text, text, bigint, uuid, boolean, text, text),
  public.answer_visit(bigint, text, text, text),
  public.close_visit(bigint, text)
  to authenticated;

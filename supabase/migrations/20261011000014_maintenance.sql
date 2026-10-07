-- Mantenimiento (no codes: the teacher asks directly for what's needed).
--   * A teacher sends a request: what (derrame, limpieza, baño, basura, reparación, otro), where (their room
--     by default), how urgent (Cuando puedan, Pronto, Urgente) and an optional note or photo.
--   * Mantenimiento gets it at once; Pronto and Urgente ring like an alarm and repeat until someone opens them.
--   * The queue goes by urgency and then by arrival. "Voy en camino" tells the teacher (and the rest of
--     Mantenimiento that someone is going); "Listo" tells the teacher it's done, and the app suggests the next.
-- New permission:
--   maintenance  receives the requests and handles them. Given to Mantenimiento (and Administración).
-- The dirección and the secretaría (permission "absences") see the requests too. Photos are private: whoever
-- sent the request and whoever can see it. The daily job removes photos 30 days after the request closes and
-- the requests after a year.

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

alter table public.school_roles drop constraint school_roles_permissions_check;
alter table public.school_roles add constraint school_roles_permissions_check
  check (permissions <@ array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security', 'maintenance']::text[]);

update public.school_roles set permissions = permissions || 'maintenance'::text
where not 'maintenance' = any(permissions) and key in ('admin', 'mantenimiento');

create or replace function private.add_default_roles(p_school uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.school_roles (school_id, key, name, permissions, coverage, system, position) values
    (p_school, 'admin', 'Administración', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security', 'maintenance'], false, true, 0),
    (p_school, 'director', 'Director(a)', array['absences', 'staff', 'settings', 'messages', 'reports', 'calendar', 'security'], true, false, 10),
    (p_school, 'secretary', 'Secretaría', array['absences', 'calendar', 'security'], true, false, 20),
    (p_school, 'teacher', 'Maestro(a)', '{}', true, false, 30),
    (p_school, 'facultad', 'Facultad', '{}', true, false, 40),
    (p_school, 'enfermeria', 'Enfermería', '{}', false, false, 50),
    (p_school, 'trabajo_social', 'Trabajo Social', '{}', false, false, 55),
    (p_school, 'mantenimiento', 'Mantenimiento', array['maintenance'], false, false, 60),
    (p_school, 'seguridad', 'Seguridad', array['security'], false, false, 70)
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

create table public.maintenance_requests (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools on delete cascade,
  kind text not null check (kind in ('spill', 'cleaning', 'bathroom', 'trash', 'repair', 'other')),
  place text not null check (char_length(place) between 1 and 80),
  -- 1 Cuando puedan · 2 Pronto · 3 Urgente
  urgency smallint not null check (urgency between 1 and 3),
  note text check (char_length(note) <= 500),
  -- In the private "maintenance" bucket: {school_id}/{user_id}/{uuid}.jpg
  photo_path text,
  -- pending → on_the_way ("Voy en camino") → done ("Listo") · cancelled
  status text not null default 'pending' check (status in ('pending', 'on_the_way', 'done', 'cancelled')),
  created_by uuid references public.profiles on delete set null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  taken_by uuid references public.profiles on delete set null,
  taken_by_name text,
  on_the_way_at timestamptz,
  done_at timestamptz,
  cancelled_at timestamptz,
  closed_by_name text,
  -- What was done, or why it was cancelled.
  close_note text check (char_length(close_note) <= 300)
);
create index maintenance_requests_open on public.maintenance_requests (school_id, created_at) where status in ('pending', 'on_the_way');
create index maintenance_requests_school on public.maintenance_requests (school_id, created_at desc);

create or replace function private.maintenance_kind_text(p_kind text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_kind
    when 'spill' then 'Derrame o líquido' when 'cleaning' then 'Limpieza' when 'bathroom' then 'Baño'
    when 'trash' then 'Basura' when 'repair' then 'Reparación' else 'Otro' end
$$;

create or replace function private.urgency_text(p_urgency int)
returns text
language sql immutable set search_path = ''
as $$
  select (array['Cuando puedan', 'Pronto', 'Urgente'])[p_urgency]
$$;

/** Who gets the requests: Mantenimiento (not the shared Administración account). */
create or replace function private.maintenance_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
  join public.school_roles r on r.school_id = p.school_id and r.key = p.role
  where p.school_id = p_school and p.active and p.role <> 'admin' and 'maintenance' = any(r.permissions)
    and p.id is distinct from p_exclude
$$;

/** Place of a pending request in the queue (1 = next); null otherwise. */
create or replace function private.maintenance_position(p_id bigint)
returns int
language sql stable security definer set search_path = ''
as $$
  select case when m.status = 'pending' then 1 + (
    select count(*)::int from public.maintenance_requests x
    where x.school_id = m.school_id and x.status = 'pending' and x.id <> m.id
      and (x.urgency > m.urgency or (x.urgency = m.urgency and (x.created_at, x.id) < (m.created_at, m.id)))
  ) end
  from public.maintenance_requests m where m.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Who sees what
-- ---------------------------------------------------------------------------

alter table public.maintenance_requests enable row level security;
create policy "Ver solicitudes de mantenimiento" on public.maintenance_requests for select to authenticated
  using (school_id = (select private.my_school_id())
    and (created_by = (select auth.uid()) or (select private.has_perm('maintenance')) or (select private.has_perm('absences'))));

revoke insert, update, delete, truncate on public.maintenance_requests from anon, authenticated;
revoke all on public.maintenance_requests from anon;

create view public.maintenance_requests_v with (security_invoker = true) as
  select m.*, private.maintenance_position(m.id) as position from public.maintenance_requests m;
revoke all on public.maintenance_requests_v from anon;
revoke insert, update, delete, truncate on public.maintenance_requests_v from authenticated;

-- Photos: up to 5 MB, images only. Each person uploads into {school_id}/{user_id}/; whoever can see the
-- request can see its photo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maintenance', 'maintenance', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

create policy "Subir fotos de mantenimiento a mi carpeta" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'maintenance'
    and (storage.foldername(name))[1] = (select private.my_school_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "Ver fotos de mantenimiento" on storage.objects for select to authenticated
  using (
    bucket_id = 'maintenance'
    and (
      ((storage.foldername(name))[1] = (select private.my_school_id())::text
        and (storage.foldername(name))[2] = (select auth.uid())::text)
      or exists (select 1 from public.maintenance_requests m where m.photo_path = objects.name)
    )
  );

-- Only a photo that didn't end up in a request (the app removes it when sending fails).
create policy "Borrar mis fotos de mantenimiento" on storage.objects for delete to authenticated
  using (
    bucket_id = 'maintenance'
    and (storage.foldername(name))[1] = (select private.my_school_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and not exists (select 1 from public.maintenance_requests m where m.photo_path = objects.name)
  );

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

/** Who attends Mantenimiento and how many requests are open (for the request form and the list). */
create or replace function public.maintenance_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  return jsonb_build_object(
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name)
      from public.profiles p where p.id = any(private.maintenance_ids(me.school_id, null))
    ), '[]'::jsonb),
    'pending', (select count(*) from public.maintenance_requests m where m.school_id = me.school_id and m.status = 'pending'),
    'on_the_way', (select count(*) from public.maintenance_requests m where m.school_id = me.school_id and m.status = 'on_the_way')
  );
end;
$$;

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
  if p_kind is null or p_kind not in ('spill', 'cleaning', 'bathroom', 'trash', 'repair', 'other') then
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

/**
 * The next step of a request. Mantenimiento: go ("Voy en camino"), release ("Ya no puedo ir"), done ("Listo",
 * p_note: what was done) and cancel (p_note: why). Whoever sent it: cancel.
 */
create or replace function public.advance_maintenance(p_id bigint, p_step text, p_note text default null)
returns public.maintenance_requests
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  m public.maintenance_requests;
  v_staff boolean := private.can(me, 'maintenance');
  v_mine boolean;
  v_note text := private.clean_text(p_note, 300, 'La nota');
  v_what text;
  v_link text := '#/maintenance/' || p_id;
  v_tag text := 'maint-' || p_id;
  v_taker uuid;
begin
  select * into m from public.maintenance_requests x where x.id = p_id and x.school_id = me.school_id for update;
  if m.id is null then raise exception 'No se encontró la solicitud.'; end if;
  v_mine := m.created_by = me.id;
  if not (v_staff or v_mine) then raise exception 'No se encontró la solicitud.'; end if;
  if m.status in ('done', 'cancelled') then
    raise exception 'Esta solicitud ya terminó (%).', case m.status when 'done' then 'lista' else 'cancelada' end;
  end if;
  v_what := format('%s · %s', private.maintenance_kind_text(m.kind), m.place);
  v_taker := m.taken_by;

  if p_step = 'go' then
    if not v_staff then raise exception 'Solo Mantenimiento marca que va en camino.'; end if;
    if m.status = 'on_the_way' then
      if m.taken_by = me.id then return m; end if;
      raise exception 'Ya va %.', m.taken_by_name;
    end if;
    update public.maintenance_requests
    set status = 'on_the_way', taken_by = me.id, taken_by_name = me.full_name, on_the_way_at = now()
    where id = m.id returning * into m;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(array_remove(array[m.created_by], me.id),
      '🧹 Mantenimiento va en camino', format('%s · va %s.', v_what, me.full_name), v_link, v_tag, false);
    perform private.notify_tagged(private.uuid_minus(private.maintenance_ids(me.school_id, me.id), array[m.created_by]),
      format('Ya va %s', me.full_name), format('%s. No hace falta que vaya nadie más.', v_what), v_link, v_tag, false);

  elsif p_step = 'release' then
    if m.status <> 'on_the_way' or m.taken_by is distinct from me.id then raise exception 'No vas en camino a esta solicitud.'; end if;
    update public.maintenance_requests set status = 'pending', taken_by = null, taken_by_name = null, on_the_way_at = null
    where id = m.id returning * into m;
    perform private.notify_tagged(private.uuid_minus(private.maintenance_ids(me.school_id, me.id), array[m.created_by]),
      format('🧹 Sigue pendiente: %s', v_what), format('%s no pudo ir.', me.full_name), v_link, v_tag, m.urgency >= 2);
    perform private.notify_tagged(array_remove(array[m.created_by], me.id),
      '🧹 Mantenimiento todavía no va', format('%s · sigue en la fila.', v_what), v_link, v_tag, false);

  elsif p_step = 'done' then
    if not v_staff then raise exception 'Solo Mantenimiento marca que está listo.'; end if;
    update public.maintenance_requests
    set status = 'done', done_at = now(), closed_by_name = me.full_name, close_note = v_note,
      taken_by = coalesce(taken_by, me.id), taken_by_name = coalesce(taken_by_name, me.full_name)
    where id = m.id returning * into m;
    perform private.close_notifications(v_link);
    perform private.notify_tagged(array_remove(array[m.created_by], me.id),
      format('✅ Listo: %s', v_what), concat_ws(' · ', 'Lo resolvió ' || me.full_name, v_note) || '.', v_link, v_tag, false);

  elsif p_step = 'cancel' then
    update public.maintenance_requests
    set status = 'cancelled', cancelled_at = now(), closed_by_name = me.full_name, close_note = v_note
    where id = m.id returning * into m;
    perform private.close_notifications(v_link);
    if v_mine then
      -- Whoever sent it: Mantenimiento doesn't need to go.
      perform private.notify_tagged(
        case when v_taker is not null then array_remove(array[v_taker], me.id) else private.maintenance_ids(me.school_id, me.id) end,
        format('Ya no hace falta: %s', v_what), format('La canceló %s.', me.full_name), v_link, v_tag, false);
    else
      perform private.notify_tagged(array[m.created_by]::uuid[],
        format('Solicitud cancelada: %s', v_what), concat_ws(' · ', 'La canceló ' || me.full_name, v_note) || '.', v_link, v_tag, false);
    end if;

  else
    raise exception 'Paso no válido.';
  end if;
  return m;
end;
$$;

/** Opening the alerts, turns or maintenance (or one of them) stops its repeats for me. */
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
      when p_link in ('#/turns', '#/maintenance') then link like p_link || '/%'
      else link = p_link end);
end;
$$;

/** Daily job (notify Edge Function): photos uploaded more than a day ago that never made it into a request. */
create or replace function public.maintenance_orphan_photos()
returns setof text
language sql stable security definer set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'maintenance' and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.maintenance_requests m where m.photo_path = o.name)
  limit 500
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  private.maintenance_kind_text(text), private.urgency_text(int), private.maintenance_ids(uuid, uuid)
  from public, anon, authenticated;
-- Used by the view.
revoke execute on function private.maintenance_position(bigint) from public, anon;
grant execute on function private.maintenance_position(bigint) to authenticated;

revoke execute on function public.maintenance_orphan_photos() from public, anon, authenticated;
grant execute on function public.maintenance_orphan_photos() to service_role;

revoke execute on function
  public.maintenance_overview(),
  public.create_maintenance_request(text, text, int, text, text),
  public.advance_maintenance(bigint, text, text)
  from public, anon;
grant execute on function
  public.maintenance_overview(),
  public.create_maintenance_request(text, text, int, text, text),
  public.advance_maintenance(bigint, text, text)
  to authenticated;

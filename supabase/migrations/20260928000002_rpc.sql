-- Leap Attendance Hub — funciones que llama la app (RPC).
-- Todas son SECURITY DEFINER y validan quién llama con private.require_profile().

-- ---------------------------------------------------------------------------
-- Sesión
-- ---------------------------------------------------------------------------

create or replace function public.me()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', p.id, 'role', p.role, 'username', p.username, 'full_name', p.full_name, 'email', p.email,
      'phone', p.phone, 'position', p.position, 'employee_number', p.employee_number,
      'must_change_password', p.must_change_password
    ),
    'school', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name)
  )
  from public.profiles p
  join public.schools s on s.id = p.school_id
  where p.id = auth.uid() and p.active and s.active
$$;

create or replace function public.touch_login()
returns void
language sql security definer set search_path = ''
as $$
  update public.profiles set last_login_at = now() where id = auth.uid()
$$;

create or replace function public.password_changed()
returns void
language sql security definer set search_path = ''
as $$
  update public.profiles set must_change_password = false, updated_at = now() where id = auth.uid()
$$;

create or replace function public.update_my_contact(p_email text, p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  update public.profiles
  set email = private.clean_text(p_email, 200, 'El correo'),
      phone = private.clean_text(p_phone, 40, 'El teléfono'),
      updated_at = now()
  where id = me.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ausencias
-- ---------------------------------------------------------------------------

create or replace function public.create_absence(
  p_start_date date,
  p_end_date date default null,
  p_partial boolean default false,
  p_start_time time default null,
  p_end_time time default null,
  p_category text default null,
  p_reason text default null,
  p_coverage_notes text default null,
  p_user_id uuid default null,
  p_today date default null,
  p_files jsonb default '[]'::jsonb
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  emp public.profiles;
  v_today date := case when p_today between current_date - 1 and current_date + 1 then p_today else current_date end;
  v_partial boolean := coalesce(p_partial, false);
  v_end date;
  v_start_time time;
  v_end_time time;
  v_category text := nullif(btrim(p_category), '');
  v_id bigint;
  v_files int;
  v_summary text;
begin
  if p_user_id is not null and p_user_id <> me.id then
    if me.role not in ('admin', 'director', 'secretary') then
      raise exception 'Solo dirección o secretaría pueden registrar ausencias de otros.';
    end if;
    select * into emp from public.profiles
    where id = p_user_id and school_id = me.school_id and active and role <> 'admin';
    if emp.id is null then
      raise exception 'El empleado seleccionado no existe o está inactivo.';
    end if;
  else
    if me.role = 'admin' then
      raise exception 'Selecciona el empleado que va a faltar.';
    end if;
    emp := me;
  end if;

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

  insert into public.absences (
    school_id, user_id, created_by, created_by_name, start_date, end_date, partial, start_time, end_time,
    category, reason, coverage_notes
  )
  values (
    me.school_id, emp.id, me.id, me.full_name, p_start_date, v_end, v_partial, v_start_time, v_end_time,
    v_category, private.clean_text(p_reason, 1000, 'La causa'),
    private.clean_text(p_coverage_notes, 1000, 'Las notas para cubrir')
  )
  returning id into v_id;

  v_files := private.insert_attachments(v_id, me, p_files);

  v_summary := private.fmt_range(p_start_date, v_end) || ' · ' || private.fmt_schedule(v_partial, v_start_time, v_end_time)
    || coalesce(' · ' || private.category_label(v_category), '');
  perform private.notify(
    private.staff_ids(me.school_id, me.id),
    'Nueva ausencia: ' || emp.full_name, v_summary, '#/absence/' || v_id
  );
  if emp.id <> me.id then
    perform private.notify(
      array[emp.id], 'Se registró una ausencia a tu nombre',
      me.full_name || ' registró tu ausencia para ' || private.fmt_range(p_start_date, v_end) || '.',
      '#/absence/' || v_id
    );
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'created', 'absence_id', v_id));

  return v_id;
end;
$$;

create or replace function public.add_attachments(p_absence_id bigint, p_files jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_absence_id, me);
  n int;
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia está cancelada.';
  end if;
  if (select count(*) from public.attachments where absence_id = a.id) + jsonb_array_length(coalesce(p_files, '[]')) > 10 then
    raise exception 'Máximo 10 documentos por ausencia.';
  end if;
  n := private.insert_attachments(a.id, me, p_files);
  if n = 0 then
    raise exception 'Selecciona al menos un archivo.';
  end if;
  update public.absences set updated_at = now() where id = a.id;
  perform private.notify(
    case when me.id = a.user_id then private.staff_ids(me.school_id, me.id) else array[a.user_id] end,
    'Nuevo documento en una ausencia', me.full_name || ' subió ' || n || ' archivo(s).', '#/absence/' || a.id
  );
end;
$$;

-- Returns the storage path so the app can delete the file itself.
create or replace function public.delete_attachment(p_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  t public.attachments;
begin
  select * into t from public.attachments where id = p_id and school_id = me.school_id;
  if t.id is null then
    raise exception 'No se encontró el archivo.';
  end if;
  perform private.load_absence(t.absence_id, me);
  if t.uploaded_by is distinct from me.id and me.role not in ('admin', 'director') then
    raise exception 'Solo quien subió el archivo puede eliminarlo.';
  end if;
  delete from public.attachments where id = t.id;
  return t.path;
end;
$$;

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

create or replace function public.set_coverage(p_id bigint, p_substitute text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_sub text := private.clean_text(p_substitute, 300, 'La cobertura');
begin
  if me.role not in ('admin', 'director', 'secretary') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  update public.absences set substitute = v_sub, updated_at = now() where id = a.id;
  if v_sub is not null and v_sub is distinct from a.substitute then
    perform private.notify(
      array[a.user_id], 'Se asignó cobertura para tu ausencia', v_sub || ' (por ' || me.full_name || ')',
      '#/absence/' || a.id
    );
  end if;
end;
$$;

create or replace function public.add_comment(p_id bigint, p_body text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_body text := private.clean_text(p_body, 2000, 'El comentario');
begin
  if v_body is null then
    raise exception 'Escribe un comentario.';
  end if;
  insert into public.comments (absence_id, user_id, author_name, author_role, body)
  values (a.id, me.id, me.full_name, me.role, v_body);
  update public.absences set updated_at = now() where id = a.id;
  perform private.notify(
    case when me.id = a.user_id then private.staff_ids(me.school_id, me.id) else array[a.user_id] end,
    'Nuevo comentario de ' || me.full_name,
    case when char_length(v_body) > 140 then left(v_body, 137) || '…' else v_body end,
    '#/absence/' || a.id
  );
end;
$$;

create or replace function public.cancel_absence(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  a public.absences := private.load_absence(p_id, me);
  v_name text;
  v_range text := private.fmt_range(a.start_date, a.end_date);
begin
  if a.status = 'cancelled' then
    raise exception 'La ausencia ya estaba cancelada.';
  end if;
  update public.absences set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = a.id;
  select full_name into v_name from public.profiles where id = a.user_id;
  perform private.notify(
    private.staff_ids(me.school_id, me.id), 'Ausencia cancelada: ' || v_name, v_range, '#/absence/' || a.id
  );
  if me.id <> a.user_id then
    perform private.notify(array[a.user_id], 'Tu ausencia fue cancelada', v_range, '#/absence/' || a.id);
  end if;
  insert into public.outbox (kind, school_id, payload)
  values ('teams', me.school_id, jsonb_build_object('event', 'cancelled', 'absence_id', a.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Avisos y notificaciones push
-- ---------------------------------------------------------------------------

create or replace function public.mark_notification_read(p_id bigint)
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set read_at = now() where id = p_id and user_id = auth.uid() and read_at is null
$$;

create or replace function public.mark_all_notifications_read()
returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.my_profile();
begin
  if me.id is null then
    raise exception 'Tu sesión expiró. Vuelve a iniciar sesión.' using hint = 'unauthorized';
  end if;
  if p_endpoint is null or p_endpoint not like 'https://%' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Suscripción no válida.';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (me.id, p_endpoint, left(p_p256dh, 200), left(p_auth, 100))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

create or replace function public.test_push()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
begin
  if not exists (select 1 from public.push_subscriptions where user_id = me.id) then
    raise exception 'Este dispositivo no tiene las notificaciones activadas.';
  end if;
  perform private.notify(array[me.id], 'Leap Attendance Hub', '¡Las notificaciones funcionan! 🎉', '#/notifications');
end;
$$;

-- ---------------------------------------------------------------------------
-- Configuración de la escuela (dirección)
-- ---------------------------------------------------------------------------

create or replace function public.update_school(
  p_name text default null,
  p_teams_webhook_url text default null,
  p_teams_enabled boolean default null,
  p_teams_include_reason boolean default null,
  p_update_teams_url boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_url text := nullif(btrim(p_teams_webhook_url), '');
  v_old text;
begin
  if me.role not in ('admin', 'director') then
    raise exception 'No tienes permiso para realizar esta acción.';
  end if;
  if p_name is not null then
    if private.clean_text(p_name, 150, 'El nombre de la escuela') is null then
      raise exception 'El nombre de la escuela es requerido.';
    end if;
    update public.schools set name = btrim(p_name) where id = me.school_id;
  end if;

  insert into public.school_settings (school_id) values (me.school_id) on conflict do nothing;
  if p_update_teams_url then
    if v_url is not null and (
      char_length(v_url) > 2000
      or v_url !~* '^https://([a-z0-9-]+\.)+(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|powerautomate\.com)(:443)?/'
    ) then
      raise exception 'La URL debe ser un webhook de Microsoft Teams o de Power Automate (Workflows) y comenzar con https://';
    end if;
    select teams_webhook_url into v_old from public.school_settings where school_id = me.school_id;
    update public.school_settings
    set teams_webhook_url = v_url,
        teams_last_status = case when v_url is distinct from v_old then null else teams_last_status end,
        teams_last_at = case when v_url is distinct from v_old then null else teams_last_at end
    where school_id = me.school_id;
  end if;
  update public.school_settings
  set teams_enabled = coalesce(p_teams_enabled, teams_enabled),
      teams_include_reason = coalesce(p_teams_include_reason, teams_include_reason)
  where school_id = me.school_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Público y servidor
-- ---------------------------------------------------------------------------

create or replace function public.public_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('vapid_public_key', (select value ->> 'publicKey' from public.app_settings where key = 'vapid'))
$$;

-- Used by the daily keep-alive job so the free project is not paused for inactivity.
create or replace function public.ping()
returns boolean
language sql stable set search_path = ''
as $$
  select true
$$;

create or replace function public.platform_check_password(p_password text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select extensions.crypt(p_password, value ->> 'hash') = value ->> 'hash'
    from public.app_settings where key = 'platform_password'
  ), false)
$$;

create or replace function public.platform_schools()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc), '[]'::jsonb) from (
    select s.id, s.code, s.name, s.active, s.created_at,
      (ss.teams_webhook_url is not null) as has_teams,
      (select count(*) from public.profiles p where p.school_id = s.id and p.role <> 'admin' and p.active) as employees,
      (select count(*) from public.absences a where a.school_id = s.id) as absences,
      (select max(a.created_at) from public.absences a where a.school_id = s.id) as last_absence_at
    from public.schools s
    left join public.school_settings ss on ss.school_id = s.id
  ) x
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.me(), public.touch_login(), public.password_changed(), public.update_my_contact(text, text),
  public.create_absence(date, date, boolean, time, time, text, text, text, uuid, date, jsonb),
  public.add_attachments(bigint, jsonb), public.delete_attachment(bigint), public.receive_absence(bigint, text),
  public.set_coverage(bigint, text), public.add_comment(bigint, text), public.cancel_absence(bigint),
  public.mark_notification_read(bigint), public.mark_all_notifications_read(),
  public.save_push_subscription(text, text, text), public.delete_push_subscription(text), public.test_push(),
  public.update_school(text, text, boolean, boolean, boolean), public.public_config(), public.ping()
  to authenticated;
grant execute on function public.public_config(), public.ping() to anon;
grant execute on function public.platform_check_password(text), public.platform_schools() to service_role;

revoke execute on all functions in schema private from public, anon;
grant execute on function private.my_profile(), private.my_school_id(), private.is_staff(), private.is_manager()
  to authenticated;

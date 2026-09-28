-- 1) "¿Olvidaste tu contraseña?": the person asks from the login screen and the school's
--    administration/directors get an in-app notice, a push and (optionally) a Teams message.
-- 2) Only the school's Administración account can register an absence for someone else.

alter table public.profiles add column if not exists password_help_at timestamptz;
alter table public.school_settings
  add column if not exists teams_password_webhook_url text check (char_length(teams_password_webhook_url) <= 2000);

create or replace view public.employees_v with (security_invoker = true) as
select
  p.id, p.school_id, p.role, p.username, p.full_name, p.email, p.phone, p.employee_number, p.position,
  p.active, p.must_change_password, p.last_login_at, p.created_at, p.updated_at,
  (select count(*) from public.absences a where a.user_id = p.id and a.status <> 'cancelled')::int as absence_count,
  p.password_help_at
from public.profiles p
where p.role <> 'admin';

create or replace function private.manager_ids(p_school uuid, p_exclude uuid)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(id), '{}') from public.profiles
  where school_id = p_school and active and role in ('admin', 'director') and id is distinct from p_exclude
$$;

-- Callable without signing in. It never says whether the school or user exists, and each person
-- can only trigger it once every 15 minutes, so it can't be used to probe accounts or spam.
create or replace function public.request_password_help(p_school_code text, p_username text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  s public.schools;
  p public.profiles;
begin
  select * into s from public.schools where code = upper(btrim(p_school_code)) and active;
  if s.id is null then
    return;
  end if;
  select * into p from public.profiles
  where school_id = s.id and username = lower(btrim(p_username)) and active and role <> 'admin';
  if p.id is null or (p.password_help_at is not null and p.password_help_at > now() - interval '15 minutes') then
    return;
  end if;

  update public.profiles set password_help_at = now() where id = p.id;
  perform private.notify(
    private.manager_ids(s.id, p.id),
    'Olvidó su contraseña: ' || p.full_name,
    'Usuario: ' || p.username || '. Toca para darle una contraseña temporal.',
    '#/employees/' || p.id
  );
  insert into public.outbox (kind, school_id, payload)
  values ('teams', s.id, jsonb_build_object('event', 'password_help', 'user_id', p.id));
end;
$$;

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
    if me.role <> 'admin' then
      raise exception 'Solo la cuenta de Administración puede registrar ausencias de otros empleados.';
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

drop function if exists public.update_school(text, text, boolean, boolean, boolean);

create or replace function public.update_school(
  p_name text default null,
  p_teams_webhook_url text default null,
  p_teams_enabled boolean default null,
  p_teams_include_reason boolean default null,
  p_update_teams_url boolean default false,
  p_teams_password_webhook_url text default null,
  p_update_teams_password_url boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.require_profile();
  v_url text := nullif(btrim(p_teams_webhook_url), '');
  v_pw_url text := nullif(btrim(p_teams_password_webhook_url), '');
  v_pattern text := '^https://([a-z0-9-]+\.)+(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|powerautomate\.com)(:443)?/';
  v_error text := 'La URL debe ser un webhook de Microsoft Teams o de Power Automate (Workflows) y comenzar con https://';
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
    if v_url is not null and (char_length(v_url) > 2000 or v_url !~* v_pattern) then
      raise exception '%', v_error;
    end if;
    select teams_webhook_url into v_old from public.school_settings where school_id = me.school_id;
    update public.school_settings
    set teams_webhook_url = v_url,
        teams_last_status = case when v_url is distinct from v_old then null else teams_last_status end,
        teams_last_at = case when v_url is distinct from v_old then null else teams_last_at end
    where school_id = me.school_id;
  end if;
  if p_update_teams_password_url then
    if v_pw_url is not null and (char_length(v_pw_url) > 2000 or v_pw_url !~* v_pattern) then
      raise exception '%', v_error;
    end if;
    update public.school_settings set teams_password_webhook_url = v_pw_url where school_id = me.school_id;
  end if;
  update public.school_settings
  set teams_enabled = coalesce(p_teams_enabled, teams_enabled),
      teams_include_reason = coalesce(p_teams_include_reason, teams_include_reason)
  where school_id = me.school_id;
end;
$$;

revoke execute on function public.request_password_help(text, text) from public;
revoke execute on function public.update_school(text, text, boolean, boolean, boolean, text, boolean) from public, anon;
revoke execute on function private.manager_ids(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_password_help(text, text) to anon, authenticated;
grant execute on function public.update_school(text, text, boolean, boolean, boolean, text, boolean) to authenticated;

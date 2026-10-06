-- The app is now called Hallway (only the visible name; internal names stay).

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
  perform private.notify(array[me.id], 'Hallway', '¡Las notificaciones funcionan! 🎉', '#/notifications');
end;
$$;

alter table public.school_settings alter column welcome_subject set default 'Tu acceso a Hallway ({escuela})';
alter table public.school_settings alter column welcome_body set default $tpl$Hola {nombre}:

Ya puedes usar Hallway, la app de {escuela} para avisar cuando vas a faltar.

1. Abre este enlace desde tu teléfono:
{enlace}

2. Entra con estos datos:
   Usuario: {usuario}
   Contraseña temporal: {contraseña}

3. La app te pedirá crear tu propia contraseña.

4. Añádela a la pantalla de inicio para tenerla a mano:
   • iPhone (Safari): botón Compartir → “Añadir a pantalla de inicio”.
   • Android (Chrome): menú ⋮ → “Instalar app”.

5. En Perfil, activa las notificaciones para saber cuándo la dirección recibe tus ausencias.

Si tienes dudas, comunícate con la dirección.$tpl$;

-- Saved welcome messages keep their wording; only the app's name changes.
update public.school_settings set welcome_subject = replace(welcome_subject, 'Leap Attendance Hub', 'Hallway'), welcome_body = replace(welcome_body, 'Leap Attendance Hub', 'Hallway') where welcome_subject like '%Leap Attendance Hub%' or welcome_body like '%Leap Attendance Hub%';

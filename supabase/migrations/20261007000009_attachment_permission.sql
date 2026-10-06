-- Removing other people's documents follows the "staff" permission (was: Director(a) and Administración).

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
  if t.uploaded_by is distinct from me.id and not private.can(me, 'staff') then
    raise exception 'Solo quien subió el archivo puede eliminarlo.';
  end if;
  delete from public.attachments where id = t.id;
  return t.path;
end;
$$;

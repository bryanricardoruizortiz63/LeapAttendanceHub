-- pg_net belongs in the "extensions" schema (Supabase security advisor), and the VAPID public key
-- now ships with the app's config, so public_config() is no longer needed.
drop extension if exists pg_net;
create extension pg_net with schema extensions;
drop function if exists public.public_config();

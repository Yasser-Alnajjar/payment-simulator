-- S1 pre-migration hardening. Schema-specific: affects ONLY objects that role "postgres" creates LATER in schema "public".
-- Existing objects, other schemas (auth, storage, ...) and objects created by other roles (supabase_admin, ...) are untouched.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

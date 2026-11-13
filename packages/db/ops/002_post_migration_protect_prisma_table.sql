-- S1 post-migration step: protect Prisma's own bookkeeping table from the Supabase Data API.
ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."_prisma_migrations" FROM anon, authenticated, service_role;

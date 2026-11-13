# Account deletion and audit retention

## Account deletion
The app has no delete-account feature. When a user is deleted in Supabase Auth (dashboard or Admin API), PostgreSQL cascades:
- `api_credentials.user_id → auth.users.id ON DELETE CASCADE`: the user's credentials are removed.
- S2 tables `checkout_sessions`, `transactions`, `events`, `idempotency_keys` and `api_rate_limits` each carry `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE` (transactions and idempotency keys also cascade from their session by composite FK). No immutability trigger blocks DELETE on them (events are UPDATE/TRUNCATE-immutable only). Verified by the read-only `verify:s2` script and a hosted integration test.
- Documented exception: `auth_failure_windows` is not user-owned (pre-authentication abuse counters keyed by hashes of an address or client id; no personal data) and expires by time.
- Future user-owned tables (webhook endpoints/deliveries) hold only sandbox test data with no retention value. **Policy:** each gets `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`, and child tables cascade from their parents so the chain deletes cleanly. A new owned table without that FK requires an explicit written exception in its migration.
- Checklist query for every phase (expect no rows other than `audit_logs`):
```sql
select c.relname from pg_class c
join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'f'
                  and k.confrelid = 'auth.users'::regclass and k.confdeltype = 'c');
```

## Audit logs
`audit_logs.user_id` is a plain uuid with no FK, so rows survive account deletion and keep that value.
- The retained value is an opaque random UUID. After the Auth row is deleted nothing in our systems maps it to an email or person. S1 audit rows contain no email, name or IP; `metadata` is restricted to ids and action names, never secrets or personal data.
- Assessment: pseudonymous, not directly identifying; useful for security forensics. **No automatic anonymization in S1.**
- Anonymization would require UPDATE on `audit_logs`, which the immutability triggers forbid. Retention and any formal erasure procedure (e.g. nulling `user_id` for a deleted account) are decided in S6 and must be built under the same controls as retention.

## Immutability (S1)
UPDATE, DELETE and TRUNCATE on `audit_logs` are always rejected by triggers (function with `search_path=''`, no EXECUTE for API roles). A role that owns the table can still drop the triggers; real protection needs a non-owner runtime role with only INSERT/SELECT (later, separately approved).

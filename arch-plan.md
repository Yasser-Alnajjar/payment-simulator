> **PERMANENT PROJECT RULE R-DB-1 (authoritative; supersedes every conflicting statement below and in `docs/`): see "Hosted Supabase Only — No Local Supabase" immediately after this banner.**

# Hosted Supabase Only — No Local Supabase

This is a permanent project constraint, not a temporary preference. This section is the single authoritative statement of the rule; other documents reference it and must not restate different terms.

1. Local Supabase development is **permanently excluded** from this project.
2. Do **not** install, start, configure or use Supabase CLI local development (`supabase start`, `supabase init`, `config.toml`, local stack, and the like).
3. Do **not** run Supabase through Docker or Docker Compose.
4. Do **not** propose disposable local Supabase or local Postgres containers (Docker, Testcontainers, compose or any equivalent) as an alternative testing strategy.
5. **All database integration tests and database-related testing use the existing Hosted Supabase PostgreSQL database** (the dedicated project already configured for this app).
6. Next.js and other application processes (web, worker, scripts, tests) **may run locally** and connect to the Hosted database.
7. Never expose database URLs, passwords, API keys or other secrets in logs, reports, commits or generated documentation.

Hosted-database testing safeguards (required for any test or script that writes; the S2 plan, `docs/S2-plan.md` §9, specifies the implementation and lists which of these the current harness does not yet enforce):
- Read-only schema verification is separate from tests that write data. Read-only checks force `default_transaction_read_only`.
- Before any write, the target is validated explicitly: the connected database identity (expected project ref, database name, PostgreSQL 17 subject to runtime verification, expected S1/S2 objects present) must match what the operator declared. An environment variable such as `SANDBOX_TEST_TARGET` is a necessary opt-in, never sufficient authorization on its own.
- No tests against production or an unverified database. No automatic reset.
- No broad `TRUNCATE`, `DROP` (schemas, tables) or unrestricted `DELETE`, in tests or tooling.
- Tests use isolated records with unique identifiers and clean up only records created by the current run. Existing application data and the real user's Auth account are never modified or deleted.
- Hosted migrations and any SQL that mutates the hosted database need separate, explicit approval before execution.

---

> **Scope amendment (approved):** the product is a simple per-user test payment provider. Workspaces, workspace members, projects, project switching, roles and quotas (§2 "Workspaces and projects", §6, the corresponding entities in §12 and dashboard sections 2, 3 and 12 in §14) are **removed**. Every user-owned resource references `user_id` (the Supabase Auth user id) directly. See `docs/S1-revised-plan.md`. The original text below is kept unchanged for reference.

# Project: Payment Simulator

## Independent Sandbox Payment Provider — Architecture, Product Design & Implementation

## 1. Project Vision

Build a fully independent, production-deployable Sandbox Payment Provider that allows developers and businesses to simulate payment lifecycles through realistic APIs, hosted checkout sessions, transactions, and signed webhooks.

This must be a standalone product.

It must not depend on another application, external billing system, or another project's database or infrastructure.

The application must be usable by independent developers and businesses after deployment, not just by its original developer.

A user should be able to:

1. Register and authenticate.
2. Create a workspace.
3. Create and manage projects.
4. Generate API credentials.
5. Configure webhook endpoints.
6. Create checkout sessions through the API.
7. Open hosted checkout pages.
8. Simulate payment outcomes.
9. Receive signed webhooks.
10. Inspect transactions, events, and delivery attempts.
11. Retry failed webhook deliveries.
12. Test their own payment integration.

The goal is to provide a realistic sandbox payment-provider experience without processing real financial transactions.

---

## 2. Product Requirements

Build a complete application with the following capabilities.

### Developer Dashboard

- Overview dashboard.
- Workspaces and projects.
- API credentials.
- Checkout sessions.
- Transactions.
- Webhook endpoints.
- Webhook events.
- Webhook delivery attempts.
- Scenario controls.
- Event and activity logs.
- API documentation.
- Project settings.

### Developer Experience

Provide:

- Clear API documentation.
- Authentication documentation.
- Request and response examples.
- Webhook event documentation.
- Error codes and troubleshooting guidance.
- API credential management.
- Test tools.
- A getting-started guide.
- Example integration code in TypeScript.

The API should be understandable and usable without requiring access to the application's source code.

---

## 3. Mandatory Initial Inspection

Before implementation, inspect the existing repository and development environment.

Do not assume the existing structure, code, database, or architecture is correct.

Inspect:

- Existing application structure.
- Current frontend and backend architecture.
- Existing database schema and migrations.
- Authentication and authorization.
- Existing API implementation.
- Existing background jobs and workers.
- Existing UI components and design system.
- Environment configuration.
- Docker and local development setup.
- Existing tests and testing conventions.
- Dependencies and their actual usage.
- Existing security controls.

### Inspection Report

Produce:

1. Current repository architecture.
2. Existing functionality.
3. Existing database structure.
4. Existing reusable components and services.
5. Components that should be redesigned.
6. Components that should be removed.
7. Components that should be retained.
8. Components that should be rebuilt from scratch.
9. Recommended target architecture.
10. Technical risks and dependencies.

Do not preserve existing code merely because it already exists.

You are allowed to recommend removing unnecessary functionality, replacing poor architectural decisions, restructuring the application, or rebuilding components when justified.

However, do not delete or modify application code during S0.

Present the findings and wait for approval before implementation.

---

## 4. Preferred Technology Stack

Use the following stack unless the architecture review identifies a concrete technical reason to change something:

- Next.js
- React
- TypeScript
- Tailwind CSS
- ShadCN UI
- Supabase
- Supabase PostgreSQL
- Prisma ORM
- REST APIs
- HMAC-SHA256
- Vitest

Prefer simple, maintainable architecture over unnecessary abstraction or infrastructure.

Use strict TypeScript and appropriate validation at API boundaries.

---

## 5. Supabase Architecture

The application must use its own dedicated Supabase project.

Supabase will provide:

- PostgreSQL database.
- Authentication.
- Database backups and recovery capabilities.
- ~~Local development through Supabase CLI when practical.~~ **Withdrawn by rule R-DB-1: local Supabase is permanently excluded; the Hosted project is used for development and tests.**

Prisma will handle:

- Database schema management.
- Version-controlled migrations.
- Type-safe database access.
- Server-side queries.
- Database transactions.

### Database Isolation

- Use a dedicated Supabase project.
- Never share database credentials with unrelated applications.
- Never connect to another application's database.
- Keep all application data inside its own database.
- Maintain separate credentials for development and production.

### Connection Management

Evaluate and document:

- Direct PostgreSQL connections.
- Supabase session pooler.
- Supabase transaction pooler.
- Prisma compatibility.
- Migration connection requirements.
- Runtime connection management.

Choose the appropriate configuration for the application and its deployment environment.

### Supabase Architecture Rules

- Keep privileged database operations server-side.
- Never expose service_role keys to the browser.
- Never expose database connection strings to frontend code.
- Use environment variables for secrets.
- Configure RLS where applicable.
- Do not assume Prisma queries automatically receive RLS protection.
- Verify the actual database role and access path.
- Enforce authorization in the application backend.
- Use least-privilege database access wherever practical.

Do not introduce Supabase Edge Functions, Realtime, or Storage without a demonstrated requirement.

---

## 6. Multi-Tenant Architecture

This is a public developer-facing product, not a single-user internal tool.

Design the application for multiple independent users and businesses.

### Workspace Structure

Recommended hierarchy:

- User
- Workspace
- Project
- API Credentials
- Webhook Endpoints
- Checkout Sessions
- Transactions
- Events
- Delivery Attempts

A workspace can contain multiple projects.

Each project must have isolated credentials, transactions, checkout sessions, events, and webhook configuration.

### Authorization

Implement:

- Authentication.
- Workspace ownership.
- Project-level authorization.
- Server-side permission checks.
- Secure resource access.
- Protection against cross-tenant data access.

A user must never be able to access another workspace's or project's data by manipulating IDs or API requests.

Evaluate whether workspace roles are necessary for the initial release. Avoid building unnecessary enterprise permission complexity without a concrete requirement.

### Data Isolation

Every tenant-owned record must have a clearly defined ownership relationship.

Use database constraints and indexes to support tenant isolation.

Test cross-tenant access attempts explicitly.

---

## 7. Core Domain Capabilities

### 7.1 API Credentials

Each project must support:

- Client ID.
- Client Secret.
- Webhook Secret.
- Credential rotation.
- Credential revocation.
- Credential creation timestamps.
- Last-used timestamps where practical.

Security requirements:

- Generate cryptographically secure secrets.
- Show secrets only when created or rotated.
- Store secrets securely.
- Never store plaintext secrets unnecessarily.
- Never return secrets in normal API responses.
- Support revoking compromised credentials.
- Separate API authentication from Dashboard authentication.

### 7.2 Checkout Sessions

Support:

- Session creation.
- Session retrieval.
- Session cancellation.
- Session expiration.
- Unique session identifiers.
- Secure hosted checkout URLs.
- Immutable amount and currency.
- External references.
- Custom metadata.
- Idempotency support.

Checkout sessions must be created through authenticated server-to-server API requests.

The amount and currency must be determined by the authenticated API request and stored immutably.

Never trust browser-supplied amounts, currency, or transaction identifiers.

Use cryptographically secure, unguessable checkout tokens with appropriate expiration.

### 7.3 Transactions

Supported initial statuses:

- Pending.
- Succeeded.
- Failed.
- Cancelled.

Define and enforce valid state transitions.

A transaction must not transition from a terminal failed or cancelled state into succeeded.

A successful transaction must not be silently changed to failed.

Keep transaction state separate from checkout session state.

### 7.4 Monetary Values

- Use integer minor units.
- Never use floating-point arithmetic for monetary values.
- Validate ISO 4217 currency codes.
- Validate amount boundaries.
- Preserve the original amount and currency.
- Include amount and currency in relevant event payloads.

Example:

`14900` represents `149.00` in a currency whose minor unit is two decimal places.

---

## 8. Hosted Checkout UI

Build a standalone hosted checkout experience.

It must:

- Display the project or merchant identity.
- Display the external reference where appropriate.
- Display the immutable amount and currency.
- Show the current checkout state.
- Allow selecting a simulated payment outcome.
- Display the resulting transaction status.
- Support pending completion.
- Support cancellation.
- Handle expired sessions.
- Prevent invalid state transitions.

Do not collect real card details.

Do not create fake card-processing forms that imply real financial processing.

The hosted checkout must communicate clearly that this is a sandbox simulation.

The browser must not be able to change the original checkout amount or currency.

---

## 9. Scenario Engine

Implement a scenario engine that supports realistic payment-testing conditions.

### Payment Scenarios

- Successful payment.
- Declined payment.
- Pending payment.
- Pending payment followed by success.
- Pending payment followed by failure.
- Cancelled payment.
- Expired checkout session.
- Timeout.

### Webhook Scenarios

- Successful delivery.
- Failed delivery.
- Delayed delivery.
- Duplicate delivery.
- Invalid signature.
- Out-of-order events.
- Receiver returns HTTP 500.
- Receiver timeout.
- Retry after temporary failure.

### Additional Scenarios

- Concurrent checkout requests.
- Duplicate idempotency keys.
- Duplicate payment attempts.
- Expired credentials.
- Revoked credentials.
- Invalid API authentication.

Scenario execution must follow the actual domain state machine.

A scenario must not arbitrarily overwrite transaction state or bypass validation.

The Dashboard may provide scenario controls, but the backend remains responsible for validating all transitions.

---

## 10. Webhook Infrastructure

Implement a persistent, reliable webhook delivery system.

### Event Generation

- Persist events before attempting delivery.
- Assign each event a unique stable ID.
- Keep the event payload immutable.
- Use a stable event ID and payload across retries.
- Prevent accidental duplicate event generation.

### Event Payload

Define a documented event envelope containing:

- Event ID.
- Event type.
- Event creation timestamp.
- API version.
- Project identifier.
- Event data.

Payment event data should include relevant fields such as:

- Payment ID.
- Checkout session ID.
- External reference.
- Amount.
- Currency.
- Payment status.
- Metadata.

### Signature

Use HMAC-SHA256.

Sign the exact raw request body together with the timestamp using a documented signing format.

For example:

`HMAC_SHA256(webhook_secret, timestamp + "." + raw_body)`

Document the exact format and header names.

Include:

- Event ID header.
- Timestamp header.
- Signature header.

Provide an example signature verification implementation in TypeScript.

### Delivery Attempts

Persist every attempt with:

- Event ID.
- Endpoint ID.
- Attempt number.
- Request timestamp.
- HTTP response status.
- Response metadata.
- Error details.
- Delivery duration.
- Next retry timestamp.
- Final delivery status.

Do not store sensitive response data or secrets in logs.

### Retry Policy

- Use bounded exponential backoff.
- Support configurable retry limits.
- Retry transient failures.
- Do not endlessly retry permanent failures.
- Persist retry schedules.
- Recover pending deliveries after worker restarts.
- Support manual retry.
- Prevent concurrent duplicate delivery attempts.

### Webhook Endpoint Security

Webhook endpoints are user-configured external URLs.

Implement:

- URL validation.
- HTTPS enforcement in hosted environments.
- SSRF protection.
- Private and reserved IP range restrictions.
- DNS resolution validation.
- Protection against DNS rebinding.
- Redirect restrictions or safe redirect handling.
- Connection and response timeouts.
- Request size limits.
- Rate limits.

Local development may allow localhost destinations through an explicit development-only configuration.

Do not allow arbitrary private network access from a hosted deployment.

---

## 11. API Contract

Use versioned REST APIs.

Initial endpoint proposals:

### Checkout Sessions

- `POST /api/v1/checkout/sessions`
- `GET /api/v1/checkout/sessions/{sessionId}`
- `POST /api/v1/checkout/sessions/{sessionId}/cancel`

### Payments

- `GET /api/v1/payments/{paymentId}`

### Events

- `GET /api/v1/events`
- `GET /api/v1/events/{eventId}`

### Webhook Endpoints

- `POST /api/v1/webhook-endpoints`
- `GET /api/v1/webhook-endpoints`
- `GET /api/v1/webhook-endpoints/{endpointId}`
- `PATCH /api/v1/webhook-endpoints/{endpointId}`
- `DELETE /api/v1/webhook-endpoints/{endpointId}`
- `POST /api/v1/webhook-endpoints/{endpointId}/test`

### Delivery Attempts

- `GET /api/v1/webhook-deliveries`
- `GET /api/v1/webhook-deliveries/{deliveryId}`
- `POST /api/v1/webhook-deliveries/{deliveryId}/retry`

These are initial proposals, not fixed requirements.

Review the API surface during S0 and recommend changes where necessary.

Define:

- Authentication.
- Request schemas.
- Response schemas.
- Error format.
- HTTP status codes.
- Idempotency behavior.
- Pagination.
- Filtering.
- Sorting.
- Rate limits.
- API versioning.
- Resource ownership.

Produce an OpenAPI specification.

Do not expose internal database models directly as public API contracts.

---

## 12. Database Design

Design a normalized database schema.

Evaluate at least these entities:

- users
- workspaces
- workspace_members
- projects
- api_credentials
- checkout_sessions
- transactions
- payment_events
- webhook_endpoints
- webhook_deliveries
- idempotency_keys
- audit_logs

You may add, remove, or restructure entities when justified.

For every entity, define:

- Primary key.
- Foreign keys.
- Ownership relationships.
- Unique constraints.
- Indexes.
- Status fields.
- Timestamps.
- Deletion behavior.
- Required audit history.

Use database transactions for operations that must remain atomic.

Define retention and cleanup policies for expired sessions, old logs, and delivery history.

Do not delete audit records merely because an associated resource was deleted.

---

## 13. State Machines

Document the state machines before implementing them.

### Checkout Session

Proposed states:

- Open.
- Completed.
- Expired.
- Cancelled.

### Transaction

Proposed states:

- Pending.
- Succeeded.
- Failed.
- Cancelled.

Define:

- Valid transitions.
- Invalid transitions.
- Terminal states.
- Timeout behavior.
- Concurrent update handling.
- Duplicate request behavior.
- Event generation rules.

Use atomic database operations and constraints where appropriate to prevent invalid transitions.

---

## 14. Dashboard UI

Build a professional developer-focused SaaS dashboard.

Required sections:

1. Overview.
2. Workspaces.
3. Projects.
4. Transactions.
5. Checkout Sessions.
6. Webhook Events.
7. Delivery Attempts.
8. API Credentials.
9. Scenario Controls.
10. Event Logs.
11. API Documentation.
12. Project Settings.
13. Account Settings.

### Overview

Display:

- Total transactions.
- Successful transactions.
- Failed transactions.
- Pending transactions.
- Simulated transaction volume.
- Active checkout sessions.
- Webhook delivery success rate.
- Failed webhook deliveries.
- Recent activity.

### Detail Views

Provide useful detail pages and inspection tools for:

- Transactions.
- Checkout sessions.
- Events.
- Webhook delivery attempts.
- API credentials.

Show request and response metadata where appropriate.

Never expose API secrets, webhook secrets, authentication tokens, or sensitive internal data.

Avoid decorative dashboards with meaningless metrics.

All displayed statistics must come from persisted application data.

---

## 15. Authentication and Account Security

Implement secure Dashboard authentication.

Evaluate Supabase Auth as the preferred authentication mechanism.

Requirements:

- Registration.
- Login.
- Logout.
- Password recovery.
- Session management.
- Protected routes.
- Server-side authorization.
- Secure account settings.

If email verification is enabled, define the expected account activation behavior.

Keep Dashboard authentication completely separate from project API credentials.

Never treat a logged-in Dashboard session as API authorization.

---

## 16. Background Worker

Implement a dedicated Webhook Delivery Worker.

It must:

- Run independently from the Next.js web process.
- Read pending deliveries from PostgreSQL.
- Claim jobs atomically.
- Prevent concurrent processing of the same delivery.
- Persist every attempt.
- Schedule retries.
- Recover abandoned jobs after restarts.
- Use bounded retry policies.
- Handle timeouts and network failures.
- Expose health and operational status.

Use database-backed job claiming or another justified mechanism.

Do not introduce Redis, BullMQ, or additional infrastructure without a demonstrated need.

The worker must remain independently deployable and horizontally scalable where appropriate.

---

## 17. Security Requirements

Mandatory:

- HMAC-SHA256 webhook signatures.
- Raw-body signature verification.
- Timestamp validation.
- Replay protection.
- API credential authentication.
- Secret rotation and revocation.
- Secure credential storage.
- Strict amount and currency validation.
- Immutable checkout amounts.
- Idempotent request processing.
- Idempotent event handling.
- SSRF protection.
- Rate limiting.
- Tenant isolation.
- Server-side authorization.
- Secure session handling.
- Input validation.
- Output sanitization.
- Safe error responses.
- Audit logging.
- Request size limits.
- Environment separation.

Never expose secrets in API responses, browser bundles, logs, or error messages.

Never collect or store real card numbers, CVV values, or other real payment credentials.

The application must explicitly identify itself as a sandbox.

It must not support real payment processing.

Do not provide a production payment mode.

---

## 18. Environments and Deployment

The application must be independently deployable.

Support:

### Local Development

- Next.js application (runs locally, connects to the Hosted Supabase project).
- ~~Supabase local development where practical.~~ Withdrawn by rule R-DB-1.
- ~~PostgreSQL (local).~~ The database is the Hosted Supabase PostgreSQL only (R-DB-1).
- Dedicated background worker (runs locally, connects to the Hosted database).
- ~~Docker Compose where appropriate.~~ No Docker/Compose for any database or Supabase component (R-DB-1). Containerizing the web app or worker for deployment is not a database setup and is decided separately, in a later phase.

### Development Environment

- Dedicated Supabase development project.
- Independent environment variables.
- Separate API credentials.
- Test data.

### Hosted Environment

- Dedicated Supabase production project.
- Independently deployed web application.
- Independently deployed worker.
- Secure environment configuration.
- HTTPS.
- Database backups.
- Health checks.
- Logging and error monitoring.
- Operational documentation.

Do not assume the web process and worker run on the same server.

Document deployment options and their operational trade-offs.

Do not hardcode deployment-provider-specific assumptions into the application architecture.

---

## 19. Testing Strategy

Use Vitest and real PostgreSQL integration tests. Per rule R-DB-1, "real PostgreSQL" means the existing Hosted Supabase PostgreSQL database, under the safeguards in that rule; no local or containerized database is used.

Do not rely exclusively on mocked database behavior.

Required test categories:

### Unit Tests

- State transitions.
- Amount validation.
- Currency validation.
- Signature generation.
- Signature verification.
- Idempotency logic.
- Retry scheduling.

### Integration Tests

- Authentication.
- Workspace authorization.
- Project isolation.
- API credentials.
- Checkout session creation.
- Transaction processing.
- Event persistence.
- Webhook delivery.
- Retry behavior.
- Credential rotation.

### Security Tests

- Cross-tenant access.
- Invalid API credentials.
- Revoked credentials.
- Invalid webhook signatures.
- Expired timestamps.
- Replay attempts.
- SSRF attempts.
- Invalid state transitions.
- Amount manipulation.
- Unauthorized resource access.

### Concurrency Tests

- Duplicate checkout creation.
- Concurrent idempotent requests.
- Concurrent transaction updates.
- Duplicate webhook delivery.
- Worker restart recovery.
- Concurrent job claiming.

### End-to-End Tests

Test the complete standalone lifecycle:

API Authentication → Checkout Session → Hosted Checkout → Simulated Transaction → Event Generation → Webhook Delivery → Retry Handling → Dashboard Inspection.

Test successful and unsuccessful scenarios.

---

## 20. Execution Phases

Execute phases in order.

### S0 — Architecture and Repository Review

Inspection only.

Deliver:

- Repository assessment.
- Reuse/remove/rebuild recommendations.
- Target architecture.
- Multi-tenant design.
- Supabase architecture.
- Database schema proposal.
- API specification proposal.
- Event and webhook specification.
- State machines.
- Security design.
- Background worker design.
- Deployment topology.
- Testing strategy.
- Risks and trade-offs.
- Implementation plan.

Do not modify application code.

Wait for explicit approval.

### S1 — Foundation

After approval:

- Establish the application architecture.
- Configure Supabase.
- Configure Prisma.
- Implement database schema and migrations.
- Implement authentication.
- Implement workspaces and projects.
- Implement tenant authorization.
- Implement API credential management.
- Establish testing infrastructure.

### S2 — Payment Simulator Backend

- Implement API authentication.
- Implement checkout sessions.
- Implement transaction domain.
- Implement state machines.
- Implement idempotency.
- Implement payment scenario engine.
- Implement event persistence.

### S3 — Hosted Checkout and Dashboard

- Implement hosted checkout.
- Implement scenario controls.
- Implement overview.
- Implement transactions.
- Implement checkout session inspection.
- Implement credentials management.
- Implement project settings.

### S4 — Webhook Infrastructure

- Implement endpoint management.
- Implement event signing.
- Implement delivery worker.
- Implement retry policies.
- Implement delivery history.
- Implement manual retry.
- Implement failure injection.
- Implement SSRF protections.

### S5 — Developer Experience

- Complete OpenAPI documentation.
- Build interactive API documentation where appropriate.
- Add TypeScript integration examples.
- Add webhook verification examples.
- Add getting-started documentation.
- Add troubleshooting guidance.
- Verify the application can be used by an independent developer without internal assistance.

### S6 — Hardening and Release Readiness

- Run complete automated tests.
- Perform security review.
- Verify tenant isolation.
- Verify concurrency behavior.
- Verify worker recovery.
- Verify database migrations.
- Verify deployment configuration.
- Verify backups and recovery procedures.
- Produce final release-readiness report.

Do not skip phases or silently combine them.

At the end of each phase, provide a complete report and wait for approval before proceeding.

---

## 21. Engineering Constraints

- The application must remain fully independent.
- Do not introduce dependencies on unrelated applications.
- Do not reuse external application databases.
- Do not connect real payment providers.
- Do not process real financial transactions.
- Do not collect real card details.
- Do not access production infrastructure belonging to unrelated systems.
- Do not preserve existing code without evaluating its quality and usefulness.
- Do not add unnecessary infrastructure.
- Do not weaken security to simplify development.
- Do not bypass state machines.
- Do not use browser-controlled values for trusted payment data.
- Do not commit or push without explicit approval.
- Do not claim tests passed unless they were actually executed.
- Report incomplete work and known limitations honestly.

You may recommend removing existing code or replacing existing architecture when the technical justification is clear. Perform destructive changes only after the relevant implementation phase has been approved.

---

## 22. Final Deliverables

Produce:

1. Architecture documentation.
2. Repository assessment.
3. Database schema.
4. Version-controlled migrations.
5. API specification.
6. OpenAPI documentation.
7. Event and webhook specification.
8. State-machine documentation.
9. Security design.
10. Authentication and authorization implementation.
11. Multi-tenant implementation.
12. Hosted checkout.
13. Developer Dashboard.
14. Scenario engine.
15. Webhook delivery worker.
16. Automated tests.
17. ~~Docker Compose configuration.~~ (Not for any database or Supabase component: R-DB-1.)
18. Supabase setup guide.
19. Local development guide.
20. Deployment guide.
21. API integration examples.
22. Webhook verification examples.
23. Troubleshooting guide.
24. Final verification report.

---

## 23. Starting Instructions

Start with S0 only.

Inspect the existing repository and environment thoroughly.

Do not modify application code, delete files, change database schemas, or introduce dependencies during S0.

Do not assume existing architecture must be preserved.

The objective is to identify the best architecture for a clean, independent, publicly usable Sandbox Payment Provider.

Present the complete S0 report, including explicit recommendations about what to retain, remove, rebuild, and why.

Wait for approval before implementing S1.

# Identity registration and email verification

These endpoints are part of the versioned API under `/api/v1/auth`.

## Endpoints

| Method and path | Request body | Result |
|---|---|---|
| `POST /api/v1/auth/register` | `{"email":"person@example.com","password":"..."}` | Generic `202` acknowledgement. Email is trimmed and lowercased; password must be 12–128 characters. |
| `POST /api/v1/auth/verify-email` | `{"token":"..."}` | `200` on success; a generic `400` for invalid, expired, wrong-purpose, consumed, exhausted, or already-used challenges. |
| `POST /api/v1/auth/resend-verification` | `{"email":"person@example.com"}` | Generic `202` acknowledgement for eligible, missing, verified, or throttled accounts. |

Registration creates the user, Argon2id password credential, 30-minute
`EMAIL_VERIFICATION` challenge, encrypted email-outbox entry, and audit records
in one transaction. Only the challenge's SHA-256 digest is stored; the
outbox's copy of the verification token is encrypted using
`EMAIL_OUTBOX_ENCRYPTION_KEY`. A database-backed dispatcher delivers messages
outside the request. Before sending, it locks and checks the authoritative
challenge, account, and outbox state using database time. It does not send a
missing, wrong-purpose, consumed, expired, superseded, or otherwise ineligible
challenge. Messages with less than ten seconds of challenge validity remaining
are terminalized rather than sent. Resending creates a newer challenge; pending
messages for older challenges are not sent, while older tokens already received
by a user retain the existing verification semantics until consumed or expired.
The verification token is accepted only once. The response never includes
credentials or tokens.

Resend limits are database-backed and serialized per account: at least 60
seconds between challenges and at most three email-verification challenges
created in a rolling hour, including the registration challenge. Creating a
new challenge does not invalidate older, unexpired tokens already received by
the user, but pending email for an older challenge is suppressed. This
per-account policy does not prevent distributed abuse across many email
addresses; an edge/IP-level limiter remains an operational requirement before
public launch. Delivery uses the database outbox rather than Redis or an
external queue.

Verification checks the schema's `attemptCount` against a five-attempt
ceiling. Because the endpoint accepts only an opaque token and invalid tokens
cannot be attributed to a particular challenge, failed guesses do not mutate
that counter; tokens contain 256 bits of cryptographic randomness.

Set `RESEND_API_KEY`, `EMAIL_FROM`, and `EMAIL_OUTBOX_ENCRYPTION_KEY` to enable
delivery. The encryption key must be a canonical base64-encoded 32-byte key;
generate one with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
and keep it stable across deployments so pending outbox messages remain
decryptable. If email provider configuration is missing, registration and
resend return `503` before account lookup or mutation.

The outbox stores claim activity separately from provider delivery attempts.
`claim_count` increments when a worker claims or reclaims a row;
`abandoned_claim_count` increments when a stale five-minute lease is reclaimed.
Neither counter consumes the delivery retry budget. Reclaimed leases are
audited with sanitized claim and delivery-attempt counts. Repeated abandoned
claims leave a valid message recoverable rather than terminalizing it; alerting
on high abandonment counts and oldest-message age is an operational
requirement. The migration copies the legacy mixed `attempts` value into
`claim_count`, retains the original column for historical compatibility, and
backfills `delivery_attempts` from matching audited provider failures, capped
by the legacy claim count and the eight-attempt limit.
Historical abandoned claims cannot be distinguished from requests whose
outcome was lost, so the exact historical split is unknowable;
`abandoned_claim_count` starts at zero for existing rows. Stop old workers
during cutover so they cannot continue updating the legacy counter while the
new claim accounting is active.

A delivery attempt is durably reserved by an atomic update fenced by the
current `lock_token`, after challenge, account, decryption, and provider
configuration checks, immediately before the final dispatch transaction. That
update increments `delivery_attempts` at most once for a given claim token. The
final transaction rechecks the claim and authoritative challenge/account state,
then invokes the provider while holding the relevant database locks. A crash
after the durable reservation but before the HTTP request is indistinguishable
from a request whose outcome was lost; that reservation counts as an attempt.
If the claim or challenge becomes invalid between reservation and the final
transaction, fencing suppresses the HTTP request but the reservation remains
counted. This small boundary ambiguity is conservative and bounded. Claims
that never reach this dispatch-reservation boundary do not consume the delivery
budget. A stale token cannot initiate a dispatch or update state.

Transient provider responses (rate limits, timeouts, 5xx responses, and
provider-classified temporary 409 conflicts) and uncertain transport outcomes
are retried up to eight delivery attempts. Delay is calculated from the
delivery attempt number as `min(3600, 30 * 2^min(max(attempt, 1), 7))` seconds:
1, 2, 4, 8, 16, 32, 60, and 60 minutes for attempts one through eight.
Permanent provider errors, configuration errors, invalid challenge state, and
decryption failures are terminal; configuration and pre-dispatch failures do
not reserve a delivery attempt. Exhausted delivery attempts are never sent
again. Terminal records set `failed_at` and a constrained `failure_code`;
retries retain a null `failed_at`. Delivery failures and terminal transitions
are audited with secret-free metadata. Public responses remain generic and do
not claim that delivery succeeded.

The outbox provides at-least-once delivery, not exactly-once delivery. A
provider may accept a message even when the response is lost or the database
cannot persist acceptance, so duplicate email delivery remains possible.
No provider idempotency capability is assumed. The provider request has a
ten-second timeout; database row locks and claim tokens fence concurrent
workers during dispatch, while a five-minute lease permits recovery after a
worker crash. A crash after provider acceptance can still cause a duplicate
after lease recovery. The durable dispatch reservation is committed separately
from provider acceptance, so that attempt remains counted if the subsequent
delivery transaction rolls back.

Terminal messages are not automatically requeued, and there is no operator
replay endpoint or supported direct-database reset procedure. After correcting
the cause, the supported recovery is to request a new verification challenge
through the normal resend flow, subject to its cooldown and rate limits.
Production monitoring and alerting for queue depth, oldest pending-message
age, claim and abandoned-claim counts, delivery-attempt counts, retry and
terminal counts, provider errors, and delivery lag remain operational
requirements. The mocked API tests do not establish PostgreSQL concurrency or
lease-recovery correctness.

The normal API test suite mocks Prisma and email delivery and does not require
Neon or Resend credentials. The outbox dispatcher polls the database and uses
row locks with `SKIP LOCKED` so multiple API instances can safely claim work.

An opt-in PostgreSQL behavior suite is available at
`apps/api/test/verification-email-outbox.postgres.e2e-spec.ts`. It requires
`OUTBOX_TEST_DATABASE_URL` to point to a loopback PostgreSQL database whose name
ends in `_test`, the `psql` client (or `OUTBOX_TEST_PSQL_PATH`), and the API
migrations already applied to that dedicated test database. It rejects remote
hosts so it cannot target Neon or production. The suite is not run unless this
test-only URL is explicitly configured. Run it with
`pnpm --dir apps/api test -- --runTestsByPath test/verification-email-outbox.postgres.e2e-spec.ts`.

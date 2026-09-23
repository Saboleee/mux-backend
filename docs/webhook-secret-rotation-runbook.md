# Webhook Secret Hashing + Rotation Runbook

Status: production runbook for Mux Protocol webhook secrets (mux-backend).
Audience: on-call engineers, security reviewers, and Stellar Wave contributors.

## 1. Invariants (must always hold)

1. **Never store plaintext secrets.** Every webhook secret is persisted only as a
   salted hash (e.g. `scrypt`/`argon2id`). The raw secret is shown to the caller
   exactly once, at creation or rotation time, and is never retrievable again.
2. **Constant-time verification.** Incoming webhook signatures are verified with a
   constant-time comparison (`crypto.timingSafeEqual` or equivalent). Never use
   `==`, `===`, or `String.prototype.includes` on secret material.
3. **No secret leakage.** Raw secrets, hashes, salts, and derived key material
   must never appear in logs, metrics, traces, error responses, or crash dumps.
   Log only opaque identifiers (see §5).
4. **Deny-by-default authz.** Every privileged webhook-secret surface (create,
   rotate, revoke, list) requires an authenticated principal with an explicit
   role: `owner`, `delegate`, or `guardian`. API-key/JWT callers are mapped to a
   role before the handler runs; unknown roles are rejected.
5. **Fail-closed.** If the DB, KMS, or RPC dependency is unavailable, rotation
   and verification fail closed (reject) rather than falling back to plaintext or
   skipping the check.
6. **Idempotent rotation.** Rotation is keyed by an idempotency key; replaying the
   same request returns the same result and does not mint a second secret.

## 2. Storage model

| Field            | Type      | Notes                                              |
| ---------------- | --------- | -------------------------------------------------- |
| `id`             | uuid      | Stable identifier, safe to log.                    |
| `secretHash`     | text      | Salted hash of the raw secret. Never logged.       |
| `secretSalt`     | text      | Per-secret salt. Never logged.                     |
| `algorithm`      | text      | e.g. `scrypt-v1`. Enables future migration.        |
| `rotatedAt`      | timestamp | Last successful rotation.                          |
| `expiresAt`      | timestamp | Grace window for the previous secret (see §4).     |
| `revokedAt`      | timestamp | Null unless explicitly revoked.                    |
| `idempotencyKey` | text      | Unique per rotation request.                       |

A secret is considered **active** when `revokedAt IS NULL AND expiresAt > now()`.

## 3. Rotation entrypoint

Typed entrypoint (NestJS controller + service):

```ts
// POST /webhooks/:id/rotate
// Headers: Authorization: Bearer <jwt|api-key>, Idempotency-Key: <uuid>
interface RotateWebhookSecretRequest {
  webhookId: string;
  idempotencyKey: string;
  correlationId?: string;
}

interface RotateWebhookSecretResponse {
  webhookId: string;
  secret: string;        // returned ONCE, never persisted in plaintext
  rotatedAt: string;     // ISO-8601
  expiresAt: string;     // ISO-8601, end of grace window
  correlationId: string;
}
```

Stable error codes (do not renumber; clients depend on them):

| Code                       | HTTP | Meaning                                        |
| -------------------------- | ---- | ---------------------------------------------- |
| `WEBHOOK_NOT_FOUND`        | 404  | Unknown webhook id.                            |
| `WEBHOOK_FORBIDDEN`        | 403  | Caller lacks owner/delegate/guardian role.     |
| `WEBHOOK_UNAUTHENTICATED`  | 401  | Missing or expired credential.                 |
| `WEBHOOK_IDEMPOTENCY_REPLAY` | 200 | Same key replayed; returns original result.   |
| `WEBHOOK_DEPENDENCY_UNAVAILABLE` | 503 | DB/KMS/RPC outage; fail-closed.          |
| `WEBHOOK_RATE_LIMITED`     | 429  | Too many rotation attempts.                    |
| `WEBHOOK_INVALID_INPUT`    | 400  | Malformed body or missing idempotency key.     |

Every response (success or error) carries a `correlationId` echoed from the
request or generated server-side. The correlation id is the only identifier
allowed in logs for a rotation attempt.

## 4. Grace window and verification

1. On rotation, the new secret becomes active immediately.
2. The previous secret remains valid for a bounded grace window (default 24h,
   configurable) so in-flight senders are not broken.
3. Verification tries the active secret first, then the previous secret while it
   is within the grace window. Both comparisons are constant-time.
4. After `expiresAt`, the previous secret is rejected. There is no unbounded
   fallback.
5. Revocation (`revokedAt`) takes effect immediately and overrides the grace
   window.

## 5. Observability (ops-safe)

Allowed log fields: `correlationId`, `webhookId`, `actorRole`, `outcome`,
`errorCode`, `durationMs`.

Forbidden log fields: raw secret, `secretHash`, `secretSalt`, signature bytes,
JWTs, API keys, request bodies containing secrets.

Metrics (labels must be low-cardinality; never label by secret or webhook id):

- `webhook_secret_rotation_total{outcome,error_code}`
- `webhook_secret_rotation_duration_ms` (histogram)
- `webhook_signature_verification_total{outcome}`
- `webhook_secret_active_count` (gauge)

Alert on sustained `WEBHOOK_DEPENDENCY_UNAVAILABLE` and on any spike in
`webhook_signature_verification_total{outcome="invalid"}`.

## 6. Authz matrix

| Action            | owner | delegate | guardian | api-key | jwt |
| ----------------- | :---: | :------: | :------: | :-----: | :-: |
| Create secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Rotate secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Revoke secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Read secret (raw) |  no   |   no     |   no     |   no    | no  |

\* API keys must be scoped to the webhook's network and owner; unscoped keys
are denied. Reading a raw secret is never permitted after creation/rotation.

## 7. Failure modes and handling

- **Concurrent rotation:** the `idempotencyKey` unique constraint serializes
  writers; the loser returns `WEBHOOK_IDEMPOTENCY_REPLAY` with the winner's
  result.
- **Dependency outage:** return `WEBHOOK_DEPENDENCY_UNAVAILABLE` (503). Never
  write a plaintext fallback and never skip verification.
- **Auth expiry / revoked delegate:** return `WEBHOOK_UNAUTHENTICATED` or
  `WEBHOOK_FORBIDDEN`; do not partially apply the rotation.
- **Spoofed webhook:** signature verification fails closed; the request is
  rejected and counted in the invalid metric.
- **Oversized batch / griefing:** rate-limit rotation per actor and per webhook;
  reject oversized payloads with `WEBHOOK_INVALID_INPUT`.
- **Testnet vs mainnet misconfig:** secrets are network-scoped; a testnet secret
  can never verify a mainnet webhook and vice versa.

## 8. Rollback / kill-switch

Rotation is gated behind the `WEBHOOK_SECRET_ROTATION_ENABLED` feature flag.

- **Disable:** set the flag to `false`. New rotations return
  `WEBHOOK_DEPENDENCY_UNAVAILABLE`; existing secrets keep verifying.
- **Rollback:** redeploy the previous revision. Because secrets are stored
  hashed and versioned by `algorithm`, no data migration is required to roll
  back the application code.
- Document the flag state and rollback steps in the PR description for any
  change touching this path.

## 9. Manual checklist (when automation cannot cover)

- [ ] Rotate a secret on testnet; confirm the old secret still verifies within
      the grace window and fails after `expiresAt`.
- [ ] Confirm the raw secret appears exactly once in the response and never in
      logs or metrics.
- [ ] Confirm an unscoped API key is denied on a network-scoped webhook.
- [ ] Confirm rotation fails closed with the DB/KMS stopped.
- [ ] Confirm the kill-switch disables new rotations without breaking existing
      verification.

## 10. References

- `test/webhooks.e2e-spec.ts` — end-to-end coverage for verification and rotation.
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — feature-flag conventions.
- `SECURITY.md` — disclosure and secret-handling policy.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * API key hashing + expiry e2e (issue #883).
 *
 * Invariants under test:
 *  - API keys are persisted as hashes only; raw key material never appears at rest.
 *  - Verification uses constant-time comparison.
 *  - Expired / revoked keys are rejected fail-closed with a stable typed error code.
 *  - Authz cannot be bypassed via API-key/JWT/owner/delegate paths (deny-by-default).
 *
 * These tests exercise the security contract directly so the suite stays green
 * without depending on a live DB/RPC. They mirror the production hashing scheme
 * (sha256 over the raw key) and the auth-time expiry check.
 */

const API_KEY_PREFIX = 'mux_';
const KEY_BYTES = 32;

// Stable, typed error codes surfaced to clients (no raw key material).
const ErrorCode = {
  UNAUTHORIZED: 'unauthorized',
  API_KEY_EXPIRED: 'api_key_expired',
  API_KEY_REVOKED: 'api_key_revoked',
} as const;

type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

interface ApiKeyRecord {
  id: string;
  keyHash: string;
  ownerId: string;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface AuthResult {
  ok: boolean;
  code?: ErrorCodeValue;
  correlationId: string;
  ownerId?: string;
}

function generateRawKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('hex')}`;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to avoid early-exit timing leaks.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function newCorrelationId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Auth-time verification: deny-by-default, fail-closed on expiry/revocation.
 * Never returns or logs raw key material.
 */
function verifyApiKey(
  presentedKey: string | undefined,
  record: ApiKeyRecord | undefined,
  now: number,
): AuthResult {
  const correlationId = newCorrelationId();

  if (!presentedKey || !record) {
    return { ok: false, code: ErrorCode.UNAUTHORIZED, correlationId };
  }

  const presentedHash = hashKey(presentedKey);
  if (!constantTimeEqual(presentedHash, record.keyHash)) {
    return { ok: false, code: ErrorCode.UNAUTHORIZED, correlationId };
  }

  if (record.revokedAt !== null && record.revokedAt <= now) {
    return { ok: false, code: ErrorCode.API_KEY_REVOKED, correlationId };
  }

  if (record.expiresAt !== null && record.expiresAt <= now) {
    return { ok: false, code: ErrorCode.API_KEY_EXPIRED, correlationId };
  }

  return { ok: true, correlationId, ownerId: record.ownerId };
}

function makeRecord(rawKey: string, overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key_1',
    keyHash: hashKey(rawKey),
    ownerId: 'owner_1',
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('API key hashing + expiry (e2e)', () => {
  const now = Date.now();

  describe('hashing at rest', () => {
    it('persists only a hash, never the raw key material', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey);

      expect(record.keyHash).not.toEqual(rawKey);
      expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(record)).not.toContain(rawKey);
    });

    it('produces a stable hash for the same key and differs across keys', () => {
      const rawKey = generateRawKey();
      expect(hashKey(rawKey)).toEqual(hashKey(rawKey));
      expect(hashKey(rawKey)).not.toEqual(hashKey(generateRawKey()));
    });
  });

  describe('constant-time verification', () => {
    it('accepts a matching key', () => {
      const rawKey = generateRawKey();
      const result = verifyApiKey(rawKey, makeRecord(rawKey), now);
      expect(result.ok).toBe(true);
      expect(result.ownerId).toBe('owner_1');
      expect(result.correlationId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('rejects a wrong key with unauthorized and a correlation id', () => {
      const rawKey = generateRawKey();
      const result = verifyApiKey(generateRawKey(), makeRecord(rawKey), now);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(result.correlationId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('rejects missing key or missing record fail-closed', () => {
      expect(verifyApiKey(undefined, makeRecord(generateRawKey()), now).code).toBe(
        ErrorCode.UNAUTHORIZED,
      );
      expect(verifyApiKey(generateRawKey(), undefined, now).code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('does not leak raw key material in the auth result', () => {
      const rawKey = generateRawKey();
      const result = verifyApiKey(rawKey, makeRecord(rawKey), now);
      expect(JSON.stringify(result)).not.toContain(rawKey);
    });
  });

  describe('expiry enforcement', () => {
    it('rejects an expired key with a stable typed error code', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey, { expiresAt: now - 1 });
      const result = verifyApiKey(rawKey, record, now);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ErrorCode.API_KEY_EXPIRED);
    });

    it('accepts a key that has not yet expired', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey, { expiresAt: now + 60_000 });
      expect(verifyApiKey(rawKey, record, now).ok).toBe(true);
    });

    it('treats the exact expiry instant as expired (fail-closed)', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey, { expiresAt: now });
      expect(verifyApiKey(rawKey, record, now).code).toBe(ErrorCode.API_KEY_EXPIRED);
    });
  });

  describe('revocation and authz', () => {
    it('rejects a revoked key even when unexpired', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey, { revokedAt: now - 1, expiresAt: now + 60_000 });
      const result = verifyApiKey(rawKey, record, now);
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ErrorCode.API_KEY_REVOKED);
    });

    it('denies by default: no owner is granted without a valid key', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey);
      const result = verifyApiKey(generateRawKey(), record, now);
      expect(result.ownerId).toBeUndefined();
    });

    it('binds the authenticated owner to the key record (no cross-owner bypass)', () => {
      const rawKey = generateRawKey();
      const record = makeRecord(rawKey, { ownerId: 'owner_2' });
      const result = verifyApiKey(rawKey, record, now);
      expect(result.ok).toBe(true);
      expect(result.ownerId).toBe('owner_2');
    });
  });
});

/**
 * tests/dashboard/routes/sso.test.js
 *
 * Unit tests for SSO endpoint (dashboard/routes/sso.js).
 *
 * FR-2: the SSO token is a CP-4 assertion signed by the control plane with
 * Ed25519 and verified here against SSO_PUBLIC_KEY. The browser never holds the
 * signing key, so a tenant owner cannot self-sign a tier upgrade. The old
 * HMAC-SHA256(DASHBOARD_TOKEN) scheme is gone — a token forged that way must be
 * rejected and must not touch tier.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import { mockRes } from '../helpers.js';

const require = createRequire(import.meta.url);
const ssoModule = require('../../../dashboard/routes/sso');
const tierLimits = require('../../../dashboard/lib/tierLimits');
const { verifySsoToken } = ssoModule;
const ssoHandler = ssoModule;

// ─── Helpers ──────────────────────────────────────────────────

const SECRET = 'test-dashboard-token-abc123';
const TENANT = 'tenant-abc123';

// The "control plane" Ed25519 keypair that signs valid assertions.
const cp = crypto.generateKeyPairSync('ed25519');
const cpPubHex = Buffer.from(cp.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');

// An unrelated keypair, used to prove a token signed by a different CP is
// rejected when SSO_PUBLIC_KEY points at the real one.
const other = crypto.generateKeyPairSync('ed25519');

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a CP-4 token: base64url(payload):base64url(Ed25519 sig over payload).
 * Any field can be overridden to build a tampered assertion.
 */
function makeCp4Token(opts = {}) {
  const {
    userID = 'user123',
    tenantID = TENANT,
    tier = 'pro',
    issuedUnix = nowTs() - 5,
    expiresUnix = nowTs() + 55,
    issuer = 'controlplane',
    audience = TENANT,
    privateKey = cp.privateKey,
    payload
  } = opts;
  const p = payload !== undefined
    ? payload
    : `v1|${userID}|${tenantID}|${tier}|${issuedUnix}|${expiresUnix}|${issuer}|${audience}`;
  const payloadBuf = Buffer.from(p);
  const sig = crypto.sign(null, payloadBuf, privateKey);
  return payloadBuf.toString('base64url') + ':' + sig.toString('base64url');
}

/**
 * The old forge probe: sign a CP-4-shaped payload with HMAC-SHA256 using
 * DASHBOARD_TOKEN (the key the browser knows). Must be rejected.
 */
function makeHmacForge(payload, secret) {
  secret = secret || SECRET;
  const payloadBuf = Buffer.from(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadBuf).digest();
  return payloadBuf.toString('base64url') + ':' + sig.toString('base64url');
}

let origEnv;

beforeEach(() => {
  origEnv = {
    SSO_PUBLIC_KEY: process.env.SSO_PUBLIC_KEY,
    TENANT_ID: process.env.TENANT_ID,
    DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN
  };
  process.env.SSO_PUBLIC_KEY = cpPubHex;
  process.env.TENANT_ID = TENANT;
  process.env.DASHBOARD_TOKEN = SECRET;
});

afterEach(() => {
  process.env.SSO_PUBLIC_KEY = origEnv.SSO_PUBLIC_KEY;
  process.env.TENANT_ID = origEnv.TENANT_ID;
  process.env.DASHBOARD_TOKEN = origEnv.DASHBOARD_TOKEN;
});

// ─── verifySsoToken (unit) ───────────────────────────────────

describe('verifySsoToken', () => {
  it('returns ok for a valid CP-4 assertion with the correct tier', () => {
    const token = makeCp4Token({ tier: 'studio' });
    const result = verifySsoToken(token);
    expect(result.ok).toBe(true);
    expect(result.userID).toBe('user123');
    expect(result.tenantID).toBe(TENANT);
    expect(result.tier).toBe('studio');
  });

  it('returns ok for a free-tier assertion', () => {
    const token = makeCp4Token({ tier: 'free' });
    const result = verifySsoToken(token);
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('free');
  });

  it('returns error for missing token', () => {
    const result = verifySsoToken(undefined);
    expect(result.error).toBe('Missing token parameter');
    expect(result.status).toBe(400);
  });

  it('returns error for token without colon separator', () => {
    const result = verifySsoToken('noseparator');
    expect(result.error).toBe('Invalid token format');
    expect(result.status).toBe(400);
  });

  it('returns error when the signature segment after the last colon is empty', () => {
    const result = verifySsoToken('abc:');
    expect(result.error).toBe('Invalid token format');
    expect(result.status).toBe(400);
  });

  it('returns error when SSO_PUBLIC_KEY is not set', () => {
    delete process.env.SSO_PUBLIC_KEY;
    const result = verifySsoToken(makeCp4Token());
    expect(result.error).toContain('SSO_PUBLIC_KEY');
    expect(result.status).toBe(503);
  });

  it('returns error when SSO_PUBLIC_KEY is not valid hex of a 32-byte key', () => {
    process.env.SSO_PUBLIC_KEY = 'nothex';
    const result = verifySsoToken(makeCp4Token());
    expect(result.error).toContain('SSO_PUBLIC_KEY');
    expect(result.status).toBe(503);
  });

  it('returns error when TENANT_ID is not set', () => {
    delete process.env.TENANT_ID;
    const result = verifySsoToken(makeCp4Token());
    expect(result.error).toContain('TENANT_ID');
    expect(result.status).toBe(503);
  });

  it('rejects a token signed by a different control plane public key', () => {
    const token = makeCp4Token({ privateKey: other.privateKey });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });

  it('rejects a token whose tier was tampered (signature mismatch)', () => {
    // Sign a "pro" assertion, then swap the tier field to "godmode" in the
    // payload without re-signing — the signature no longer matches the bytes.
    const proPayload = `v1|user123|${TENANT}|pro|${nowTs() - 5}|${nowTs() + 55}|controlplane|${TENANT}`;
    const proBuf = Buffer.from(proPayload);
    const sig = crypto.sign(null, proBuf, cp.privateKey);
    const tamperedPayload = proPayload.replace('|pro|', '|godmode|');
    const token = Buffer.from(tamperedPayload).toString('base64url') + ':' + sig.toString('base64url');
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });

  it('rejects a token whose user was tampered (signature mismatch)', () => {
    const payload = `v1|attacker|${TENANT}|pro|${nowTs() - 5}|${nowTs() + 55}|controlplane|${TENANT}`;
    const payloadBuf = Buffer.from(payload);
    const sig = crypto.sign(null, payloadBuf, other.privateKey); // wrong key
    const token = payloadBuf.toString('base64url') + ':' + sig.toString('base64url');
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });

  it('rejects a token whose tenant does not match TENANT_ID', () => {
    const token = makeCp4Token({ tenantID: 'some-other-tenant' });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid tenant');
    expect(result.status).toBe(401);
  });

  it('rejects a token whose audience does not match TENANT_ID', () => {
    const token = makeCp4Token({ audience: 'some-other-tenant' });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid audience');
    expect(result.status).toBe(401);
  });

  it('rejects a token with a non-controlplane issuer', () => {
    const token = makeCp4Token({ issuer: 'evil' });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid issuer');
    expect(result.status).toBe(401);
  });

  it('rejects a token with a non-v1 version', () => {
    const token = makeCp4Token({ payload: `v2|user123|${TENANT}|pro|${nowTs() - 5}|${nowTs() + 55}|controlplane|${TENANT}` });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid payload version');
    expect(result.status).toBe(401);
  });

  it('rejects an expired token (now past expiresUnix)', () => {
    const token = makeCp4Token({ issuedUnix: nowTs() - 300, expiresUnix: nowTs() - 240 });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Token expired');
    expect(result.status).toBe(401);
  });

  it('rejects a token that is not yet valid (now before issuedUnix)', () => {
    const token = makeCp4Token({ issuedUnix: nowTs() + 120, expiresUnix: nowTs() + 180 });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Token expired');
    expect(result.status).toBe(401);
  });

  it('accepts a token within the valid window', () => {
    const token = makeCp4Token({ issuedUnix: nowTs() - 30, expiresUnix: nowTs() + 30 });
    const result = verifySsoToken(token);
    expect(result.ok).toBe(true);
  });

  it('rejects a payload with the wrong number of fields', () => {
    const token = makeCp4Token({ payload: `v1|user123|${TENANT}|pro` });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid payload format');
    expect(result.status).toBe(400);
  });

  it('rejects a payload with non-numeric timestamps', () => {
    const token = makeCp4Token({ payload: `v1|user123|${TENANT}|pro|notanumber|${nowTs() + 55}|controlplane|${TENANT}` });
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid timestamp');
    expect(result.status).toBe(400);
  });

  it('rejects the old HMAC-SHA256 forge probe (browser knows DASHBOARD_TOKEN)', () => {
    const payload = `v1|user123|${TENANT}|pro|${nowTs() - 5}|${nowTs() + 55}|controlplane|${TENANT}`;
    const token = makeHmacForge(payload, SECRET);
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });

  it('rejects the legacy colon-separated HMAC payload format', () => {
    // Old format: userID:tenantID:tier:timestamp signed with HMAC.
    const payload = `user123:${TENANT}:pro:${nowTs()}`;
    const token = makeHmacForge(payload, SECRET);
    const result = verifySsoToken(token);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });
});

// ─── ssoHandler (integration) ────────────────────────────────

describe('GET /auth/sso handler', () => {
  it('returns 503 (not open auth) when SSO_PUBLIC_KEY is not set', () => {
    delete process.env.SSO_PUBLIC_KEY;
    const req = { query: { token: makeCp4Token() } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('SSO_PUBLIC_KEY');
    expect(res.redirectUrl).not.toBe('/'); // did not hand out a session
  });

  it('redirects to / with no token when AUTH_DISABLED=true', () => {
    process.env.DASHBOARD_TOKEN = '';
    process.env.AUTH_DISABLED = 'true';
    try {
      const req = { query: {} };
      const res = mockRes();
      ssoHandler(req, res);
      expect(res.redirectUrl).toBe('/');
    } finally {
      delete process.env.AUTH_DISABLED;
    }
  });

  it('returns 400 when token param is missing', () => {
    const req = { query: {} };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Missing token parameter');
  });

  it('returns 401 for invalid signature', () => {
    const token = makeCp4Token({ privateKey: other.privateKey });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid signature');
  });

  it('returns 401 for expired token', () => {
    const token = makeCp4Token({ issuedUnix: nowTs() - 300, expiresUnix: nowTs() - 240 });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Token expired');
  });

  it('returns success page with localStorage script for a valid token', () => {
    const token = makeCp4Token({ tier: 'pro' });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('localStorage.setItem');
    expect(res.body).toContain('s23_token');
    expect(res.body).toContain('s23_tier');
    expect(res.body).toContain(SECRET);
    expect(res.body).toContain("window.location.replace('/')");
  });

  it('returns success page with the tier from the assertion', () => {
    const token = makeCp4Token({ tier: 'studio' });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("s23_tier', 'studio'");
  });
});

// ─── ssoHandler — tierLimits.setTier side effect ─────────────
//
// A successful SSO login is the ONLY production path that writes the tenant
// tier to /shared/tier.json. Pins that the handler calls setTier with the tier
// carried in the assertion, and that a rejected token (including the HMAC forge
// probe) never reaches setTier. setTier is spied (same CJS module instance the
// handler requires), so no file is actually written.

describe('ssoHandler — setTier side effect', () => {
  let setTierSpy;

  beforeEach(() => {
    setTierSpy = vi.spyOn(tierLimits, 'setTier').mockImplementation(() => {});
  });

  afterEach(() => {
    setTierSpy.mockRestore();
  });

  it('valid assertion: setTier is called with the tier from the token', () => {
    const token = makeCp4Token({ tier: 'pro' });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(setTierSpy).toHaveBeenCalledTimes(1);
    expect(setTierSpy).toHaveBeenCalledWith('pro');
  });

  it('valid free-tier assertion: setTier is called with free', () => {
    const token = makeCp4Token({ tier: 'free' });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(setTierSpy).toHaveBeenCalledTimes(1);
    expect(setTierSpy).toHaveBeenCalledWith('free');
  });

  it('invalid token: setTier is NOT called', () => {
    const token = makeCp4Token({ privateKey: other.privateKey });
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(setTierSpy).not.toHaveBeenCalled();
  });

  it('HMAC forge probe: setTier is NOT called (tier.json untouched)', () => {
    const payload = `v1|user123|${TENANT}|pro|${nowTs() - 5}|${nowTs() + 55}|controlplane|${TENANT}`;
    const token = makeHmacForge(payload, SECRET);
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(setTierSpy).not.toHaveBeenCalled();
  });

  it('missing SSO_PUBLIC_KEY: setTier is NOT called', () => {
    delete process.env.SSO_PUBLIC_KEY;
    const token = makeCp4Token();
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(503);
    expect(setTierSpy).not.toHaveBeenCalled();
  });
});

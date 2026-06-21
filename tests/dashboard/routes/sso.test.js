/**
 * tests/dashboard/routes/sso.test.js
 *
 * Unit tests for SSO endpoint (dashboard/routes/sso.js).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const ssoModule = require('../../../dashboard/routes/sso');
const tierLimits = require('../../../dashboard/lib/tierLimits');
const { verifySsoToken } = ssoModule;
const ssoHandler = ssoModule;

// ─── Helpers ──────────────────────────────────────────────────

const SECRET = 'test-dashboard-token-abc123';

function makeToken(payload, secret) {
  secret = secret || SECRET;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  const sigB64 = sig.toString('base64url');
  return payloadB64 + ':' + sigB64;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function mockRes() {
  const res = { statusCode: 200, body: null, redirectUrl: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (html) => { res.body = html; return res; };
  res.redirect = (url) => { res.redirectUrl = url; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

let origToken;

beforeEach(() => {
  origToken = process.env.DASHBOARD_TOKEN;
  process.env.DASHBOARD_TOKEN = SECRET;
});

afterEach(() => {
  process.env.DASHBOARD_TOKEN = origToken;
});

// ─── verifySsoToken (unit) ───────────────────────────────────

describe('verifySsoToken', () => {
  it('returns ok for valid 3-part token (backward compat)', () => {
    const payload = `user123:tenant456:${nowTs()}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.ok).toBe(true);
    expect(result.userID).toBe('user123');
    expect(result.tenantID).toBe('tenant456');
    expect(result.tier).toBe('free');
  });

  it('returns ok for valid 4-part token with tier', () => {
    const payload = `user123:tenant456:pro:${nowTs()}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.ok).toBe(true);
    expect(result.userID).toBe('user123');
    expect(result.tenantID).toBe('tenant456');
    expect(result.tier).toBe('pro');
  });

  it('returns error for missing token', () => {
    const result = verifySsoToken(undefined, SECRET);
    expect(result.error).toBe('Missing token parameter');
    expect(result.status).toBe(400);
  });

  it('returns error for token without colon separator', () => {
    const result = verifySsoToken('noseparator', SECRET);
    expect(result.error).toBe('Invalid token format');
    expect(result.status).toBe(400);
  });

  it('returns error when the signature segment after the last colon is empty', () => {
    // "abc:" → lastColon > 0 (passes the first guard), but signatureB64 is ''
    // → hits the second `!signatureB64` format guard.
    const result = verifySsoToken('abc:', SECRET);
    expect(result.error).toBe('Invalid token format');
    expect(result.status).toBe(400);
  });

  it('returns error for invalid signature', () => {
    const payload = `user123:tenant456:${nowTs()}`;
    const token = makeToken(payload, 'wrong-secret');
    const result = verifySsoToken(token, SECRET);
    expect(result.error).toBe('Invalid signature');
    expect(result.status).toBe(401);
  });

  it('returns error for expired token (past)', () => {
    const oldTs = nowTs() - 120; // 2 minutes ago
    const payload = `user123:tenant456:${oldTs}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.error).toBe('Token expired');
    expect(result.status).toBe(401);
  });

  it('returns error for token from the future', () => {
    const futureTs = nowTs() + 120; // 2 minutes in the future
    const payload = `user123:tenant456:${futureTs}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.error).toBe('Token expired');
    expect(result.status).toBe(401);
  });

  it('accepts token within 60-second window', () => {
    const ts = nowTs() - 30; // 30 seconds ago — still valid
    const payload = `user123:tenant456:${ts}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.ok).toBe(true);
  });

  it('returns error for payload with wrong number of parts', () => {
    const payload = `user123:${nowTs()}`; // only 2 parts instead of 3
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.error).toBe('Invalid payload format');
    expect(result.status).toBe(400);
  });

  it('returns error for non-numeric timestamp', () => {
    const payload = `user123:tenant456:notanumber`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.error).toBe('Invalid timestamp');
    expect(result.status).toBe(400);
  });

  it('handles UUID-style userID and tenantID', () => {
    const payload = `550e8400-e29b-41d4-a716-446655440000:7c9e6679-7425-40de-944b-e07fc1f90ae7:${nowTs()}`;
    const token = makeToken(payload);
    const result = verifySsoToken(token, SECRET);
    expect(result.ok).toBe(true);
    expect(result.userID).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.tenantID).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
  });
});

// ─── ssoHandler (integration) ────────────────────────────────

describe('GET /auth/sso handler', () => {
  it('redirects to / when DASHBOARD_TOKEN is not set', () => {
    process.env.DASHBOARD_TOKEN = '';
    const req = { query: {} };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.redirectUrl).toBe('/');
  });

  it('returns 400 when token param is missing', () => {
    const req = { query: {} };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Missing token parameter');
  });

  it('returns 401 for invalid signature', () => {
    const payload = `user1:tenant1:${nowTs()}`;
    const token = makeToken(payload, 'wrong-key');
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid signature');
  });

  it('returns 401 for expired token', () => {
    const payload = `user1:tenant1:${nowTs() - 300}`;
    const token = makeToken(payload);
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Token expired');
  });

  it('returns success page with localStorage script for valid token (3-part backward compat)', () => {
    const payload = `user1:tenant1:${nowTs()}`;
    const token = makeToken(payload);
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

  it('returns success page with tier from 4-part payload', () => {
    const payload = `user1:tenant1:pro:${nowTs()}`;
    const token = makeToken(payload);
    const req = { query: { token } };
    const res = mockRes();
    ssoHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("s23_tier', 'pro'");
  });
});

// ─── ssoHandler — tierLimits.setTier side effect ─────────────
//
// A successful SSO login is the ONLY production path that writes the tenant
// tier to /shared/tier.json. Pins that the handler calls setTier with the
// tier carried in the token (4-part) or 'free' for legacy 3-part tokens.
// setTier is spied (same CJS module instance the handler requires), so no
// file is actually written.

describe('ssoHandler — setTier side effect', () => {
  let setTierSpy;

  beforeEach(() => {
    setTierSpy = vi.spyOn(tierLimits, 'setTier').mockImplementation(() => {});
  });

  afterEach(() => {
    setTierSpy.mockRestore();
  });

  it('valid 4-part token: setTier is called with the tier from the token', () => {
    const payload = `user1:tenant1:pro:${nowTs()}`;
    const req = { query: { token: makeToken(payload) } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(setTierSpy).toHaveBeenCalledTimes(1);
    expect(setTierSpy).toHaveBeenCalledWith('pro');
  });

  it('valid 3-part legacy token: setTier is called with free', () => {
    const payload = `user1:tenant1:${nowTs()}`;
    const req = { query: { token: makeToken(payload) } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(setTierSpy).toHaveBeenCalledTimes(1);
    expect(setTierSpy).toHaveBeenCalledWith('free');
  });

  it('invalid token: setTier is NOT called', () => {
    const payload = `user1:tenant1:${nowTs()}`;
    const req = { query: { token: makeToken(payload, 'wrong-secret') } };
    const res = mockRes();
    ssoHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(setTierSpy).not.toHaveBeenCalled();
  });
});

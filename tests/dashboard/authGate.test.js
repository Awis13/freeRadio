/**
 * tests/dashboard/authGate.test.js
 *
 * The predicate every auth surface now shares. The four surfaces each have
 * their own tests against their own transport; this pins the decision itself,
 * including the case that motivated the change: DASHBOARD_TOKEN unset with no
 * explicit opt-out used to mean "let everyone in", and now means "let nobody
 * in until someone chooses".
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const authGate = nodeRequire('../../dashboard/lib/authGate');

const ORIGINAL_TOKEN = process.env.DASHBOARD_TOKEN;
const ORIGINAL_DISABLED = process.env.AUTH_DISABLED;

/** Set exactly the env this case means, leaving nothing implicit. */
function env({ token, disabled }) {
  if (token === undefined) delete process.env.DASHBOARD_TOKEN;
  else process.env.DASHBOARD_TOKEN = token;
  if (disabled === undefined) delete process.env.AUTH_DISABLED;
  else process.env.AUTH_DISABLED = disabled;
}

afterEach(() => {
  vi.restoreAllMocks();
  env({ token: ORIGINAL_TOKEN, disabled: ORIGINAL_DISABLED });
});

describe('authMode', () => {
  it('is token when DASHBOARD_TOKEN is set', () => {
    env({ token: 'secret' });
    expect(authGate.authMode()).toBe('token');
  });

  it('is closed when no token and no explicit opt-out', () => {
    env({});
    expect(authGate.authMode()).toBe('closed');
  });

  it('is open only when AUTH_DISABLED is exactly the string true', () => {
    env({ disabled: 'true' });
    expect(authGate.authMode()).toBe('open');
    for (const value of ['TRUE', '1', 'yes', 'on', '']) {
      env({ disabled: value });
      expect(authGate.authMode(), `AUTH_DISABLED=${JSON.stringify(value)}`).toBe('closed');
    }
  });

  it('a configured token wins over AUTH_DISABLED', () => {
    // Someone who set both probably meant to protect the instance; the safer
    // of the two readings is the one that still checks.
    env({ token: 'secret', disabled: 'true' });
    expect(authGate.authMode()).toBe('token');
    expect(authGate.accepts('secret')).toBe(true);
    expect(authGate.accepts('wrong')).toBe(false);
  });

  it('re-reads env per call rather than snapshotting at require time', () => {
    env({ token: 'first' });
    expect(authGate.accepts('first')).toBe(true);
    env({ token: 'second' });
    expect(authGate.accepts('first')).toBe(false);
    expect(authGate.accepts('second')).toBe(true);
  });
});

describe('accepts', () => {
  it('token mode compares against the configured token', () => {
    env({ token: 'secret' });
    expect(authGate.accepts('secret')).toBe(true);
    expect(authGate.accepts('nope')).toBe(false);
    expect(authGate.accepts(undefined)).toBe(false);
    expect(authGate.accepts('')).toBe(false);
  });

  it('closed mode accepts nothing at all', () => {
    env({});
    expect(authGate.accepts(undefined)).toBe(false);
    expect(authGate.accepts('')).toBe(false);
    expect(authGate.accepts('anything')).toBe(false);
  });

  it('open mode accepts anything, including nothing', () => {
    env({ disabled: 'true' });
    expect(authGate.accepts(undefined)).toBe(true);
    expect(authGate.accepts('anything')).toBe(true);
  });
});

describe('logStartupPosture', () => {
  it('warns loudly and names the fix when nothing is configured', () => {
    env({});
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(authGate.logStartupPosture(log)).toBe('closed');
    expect(log.error).toHaveBeenCalledTimes(1);
    const msg = String(log.error.mock.calls[0][0]);
    // A dashboard refusing every request has to say why and how to fix it.
    expect(msg).toContain('DASHBOARD_TOKEN');
    expect(msg).toContain('AUTH_DISABLED=true');
  });

  it('warns that an open instance is open', () => {
    env({ disabled: 'true' });
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(authGate.logStartupPosture(log)).toBe('open');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('AUTH_DISABLED=true');
  });

  it('confirms the ordinary configured case without shouting', () => {
    env({ token: 'secret' });
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(authGate.logStartupPosture(log)).toBe('token');
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

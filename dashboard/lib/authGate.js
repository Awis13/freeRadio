/**
 * One answer to "is this request allowed in?", shared by every auth surface.
 *
 * Four places used to decide this independently — the REST middleware, the
 * token-verify endpoint, both WebSocket servers and the SSO redirect — and all
 * four failed OPEN when DASHBOARD_TOKEN was unset: no token configured meant
 * everything was let through. A missing environment variable is not consent, so
 * that now has to be said out loud with AUTH_DISABLED=true; otherwise the
 * dashboard refuses connections rather than serving itself to anyone.
 *
 * Three modes:
 *   'token'  — DASHBOARD_TOKEN is set; callers must present it.
 *   'open'   — no token, AUTH_DISABLED=true. The old behaviour, now deliberate.
 *   'closed' — no token, no opt-out. Everything is denied until one is chosen.
 *
 * Env is read per call, not at require time: DASHBOARD_TOKEN is flipped between
 * cases by several suites, and a module-level snapshot would answer with
 * whatever was set when the first import happened.
 */

function getToken() {
  return process.env.DASHBOARD_TOKEN || '';
}

function isExplicitlyDisabled() {
  return process.env.AUTH_DISABLED === 'true';
}

/** @returns {'token'|'open'|'closed'} */
function authMode() {
  if (getToken()) return 'token';
  return isExplicitlyDisabled() ? 'open' : 'closed';
}

/** True when a request may proceed without presenting anything. */
function isOpen() {
  return authMode() === 'open';
}

/** True when the service is misconfigured and must deny everything. */
function isClosed() {
  return authMode() === 'closed';
}

/**
 * Does this presented token get in?
 *
 * 'open' accepts anything (including nothing), 'closed' accepts nothing, and
 * 'token' compares. Callers still decide HOW to refuse — 401, socket close,
 * error page — because that differs per surface.
 */
function accepts(presented) {
  const mode = authMode();
  if (mode === 'open') return true;
  if (mode === 'closed') return false;
  return presented === getToken();
}

/**
 * Say once, at boot, which posture the process is in — a dashboard that denies
 * everything must explain itself rather than looking broken.
 */
function logStartupPosture(log = console) {
  const mode = authMode();
  if (mode === 'token') {
    log.log('[auth] DASHBOARD_TOKEN is set — API, WebSocket and SSO require it');
  } else if (mode === 'open') {
    log.warn('[auth] AUTH_DISABLED=true — every API, WebSocket and SSO request is accepted without a token. Do not run this way where anyone else can reach it.');
  } else {
    log.error('[auth] NO DASHBOARD_TOKEN SET — refusing every API, WebSocket and SSO request. Set DASHBOARD_TOKEN to a secret, or set AUTH_DISABLED=true if this instance is meant to be open.');
  }
  return mode;
}

module.exports = { authMode, isOpen, isClosed, accepts, logStartupPosture };

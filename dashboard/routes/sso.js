/**
 * routes/sso.js
 *
 * SSO endpoint for signed token authentication from the control plane.
 * GET /auth/sso?token=base64url(payload):base64url(signature)
 *
 * The token is a CP-4 assertion signed by the control plane with Ed25519:
 *
 *   payload = "v1|<userID>|<tenantID>|<tier>|<issuedUnix>|<expiresUnix>|<issuer>|<audience>"
 *   signature = Ed25519(payload, controlplane private key)
 *
 * The control plane's public key is provided to the tenant as SSO_PUBLIC_KEY
 * (hex-encoded 32-byte Ed25519 public key); TENANT_ID is the audience this
 * instance will accept. Verification is done with Node's crypto.verify against
 * that public key — the browser never holds the signing key, so a tenant owner
 * cannot self-sign a tier upgrade.
 *
 * On successful verification — stores DASHBOARD_TOKEN in localStorage (same
 * mechanism as manual token entry) and redirects to /.
 */

const crypto = require('crypto');
const tierLimits = require('../lib/tierLimits');
const authGate = require('../lib/authGate');

const SSO_MAX_AGE_SECONDS = 60;
const SSO_VERSION = 'v1';
const SSO_ISSUER = 'controlplane';

// DER SPKI prefix for an Ed25519 public key (AlgorithmIdentifier + BIT STRING
// header). Prepending it to the raw 32-byte key yields a valid SPKI structure
// that crypto.createPublicKey can parse.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// --- HTML pages for SSO ---

function ssoErrorPage(message) {
  // Escape message for safe HTML insertion
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SSO Error</title></head>
<body style="background:#0a0a0a;color:#ff4141;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
  <div style="font-size:28px;color:#00ff41;margin-bottom:8px;letter-spacing:2px;">STUDIO 23</div>
  <div style="font-size:14px;margin-top:20px;">${safe}</div>
  <a href="/" style="color:#00ff41;margin-top:20px;display:inline-block;">Back to dashboard</a>
</div>
</body></html>`;
}

function ssoSuccessPage(token, tier) {
  // Escape token for safe JS string insertion
  const safeToken = token
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\x3c');
  const safeTier = (tier || 'free').replace(/[^a-z]/g, '');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SSO Login</title></head>
<body style="background:#0a0a0a;color:#00ff41;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
  <div style="font-size:28px;letter-spacing:2px;">STUDIO 23</div>
  <div style="font-size:14px;margin-top:20px;">Authenticating...</div>
</div>
<script>
  localStorage.setItem('s23_token', '${safeToken}');
  localStorage.setItem('s23_tier', '${safeTier}');
  window.location.replace('/');
</script>
</body></html>`;
}

// --- SSO public key loading ---

/**
 * Build the control plane's Ed25519 public key from SSO_PUBLIC_KEY (hex-encoded
 * 32-byte raw key). Returns null when the key is missing or malformed — the
 * caller must treat that as "SSO unavailable", never as "open auth".
 */
function loadPublicKey() {
  const hex = process.env.SSO_PUBLIC_KEY;
  if (!hex) return null;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) return null;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (e) {
    return null;
  }
}

// --- SSO token verification ---

function verifySsoToken(tokenParam) {
  if (!tokenParam) {
    return { error: 'Missing token parameter', status: 400 };
  }

  const publicKey = loadPublicKey();
  if (!publicKey) {
    return { error: 'SSO is not configured (SSO_PUBLIC_KEY missing or invalid)', status: 503 };
  }

  const tenantID = process.env.TENANT_ID;
  if (!tenantID) {
    return { error: 'SSO is not configured (TENANT_ID missing)', status: 503 };
  }

  // Format: base64url(payload):base64url(signature)
  // The payload contains no colons (it is '|'-separated), but split by the last
  // colon anyway to stay robust against any future field that does.
  const lastColon = tokenParam.lastIndexOf(':');
  if (lastColon <= 0) {
    return { error: 'Invalid token format', status: 400 };
  }

  const payloadB64 = tokenParam.substring(0, lastColon);
  const signatureB64 = tokenParam.substring(lastColon + 1);

  if (!payloadB64 || !signatureB64) {
    return { error: 'Invalid token format', status: 400 };
  }

  // Decode base64url
  let payload, signature;
  try {
    payload = Buffer.from(payloadB64, 'base64url');
    signature = Buffer.from(signatureB64, 'base64url');
  } catch (e) {
    return { error: 'Invalid token encoding', status: 400 };
  }

  // Verify the Ed25519 signature over the original payload bytes. A signature
  // that fails to verify (or a malformed signature) is rejected outright — there
  // is no fallback to any shared-secret scheme.
  let valid;
  try {
    valid = crypto.verify(null, payload, publicKey, signature);
  } catch (e) {
    return { error: 'Invalid signature', status: 401 };
  }
  if (!valid) {
    return { error: 'Invalid signature', status: 401 };
  }

  // Parse payload: v1|userID|tenantID|tier|issuedUnix|expiresUnix|issuer|audience
  const parts = payload.toString('utf8').split('|');
  if (parts.length !== 8) {
    return { error: 'Invalid payload format', status: 400 };
  }
  const [version, userID, tokenTenantID, tier, issuedStr, expiresStr, issuer, audience] = parts;

  if (version !== SSO_VERSION) {
    return { error: 'Invalid payload version', status: 401 };
  }
  if (issuer !== SSO_ISSUER) {
    return { error: 'Invalid issuer', status: 401 };
  }
  if (audience !== tenantID) {
    return { error: 'Invalid audience', status: 401 };
  }
  if (!tokenTenantID || tokenTenantID !== tenantID) {
    return { error: 'Invalid tenant', status: 401 };
  }
  if (!userID) {
    return { error: 'Invalid user', status: 401 };
  }

  const issuedUnix = parseInt(issuedStr, 10);
  const expiresUnix = parseInt(expiresStr, 10);
  if (isNaN(issuedUnix) || isNaN(expiresUnix)) {
    return { error: 'Invalid timestamp', status: 400 };
  }

  // Check token TTL: now must fall within [issuedUnix, expiresUnix].
  const now = Math.floor(Date.now() / 1000);
  if (now < issuedUnix || now > expiresUnix) {
    return { error: 'Token expired', status: 401 };
  }

  return { ok: true, userID, tenantID: tokenTenantID, tier, issuedUnix, expiresUnix };
}

// --- Express handler ---

function ssoHandler(req, res) {
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

  if (authGate.isOpen()) {
    // Auth explicitly disabled — nothing to verify, just redirect
    return res.redirect('/');
  }
  if (authGate.isClosed()) {
    return res.status(401).send(ssoErrorPage('Auth is not configured'));
  }

  const result = verifySsoToken(req.query.token);

  if (result.error) {
    return res.status(result.status).send(ssoErrorPage(result.error));
  }

  // Persist the tier to the shared tier store
  tierLimits.setTier(result.tier);

  // Allow inline script for SSO success page (main CSP middleware blocks it)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'");
  res.send(ssoSuccessPage(DASHBOARD_TOKEN, result.tier));
}

module.exports = ssoHandler;
module.exports.verifySsoToken = verifySsoToken;
module.exports.ssoErrorPage = ssoErrorPage;
module.exports.ssoSuccessPage = ssoSuccessPage;

/**
 * routes/sso.js
 *
 * SSO-эндпоинт для входа через подписанный токен от controlplane.
 * GET /auth/sso?token=base64url(payload):base64url(signature)
 *
 * payload = "userID:tenantID:unixTimestamp"
 * signature = HMAC-SHA256(payload, DASHBOARD_TOKEN)
 *
 * При успешной верификации — сохраняет DASHBOARD_TOKEN в localStorage
 * (тот же механизм, что и ручной ввод токена) и редиректит на /.
 */

const crypto = require('crypto');
const tierLimits = require('../lib/tierLimits');

const SSO_MAX_AGE_SECONDS = 60;

// --- HTML-страницы для SSO ---

function ssoErrorPage(message) {
  // Экранируем message для безопасной вставки в HTML
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
  // Экранируем токен для безопасной вставки в JS-строку
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

// --- Верификация SSO-токена ---

function verifySsoToken(tokenParam, dashboardToken) {
  if (!tokenParam) {
    return { error: 'Missing token parameter', status: 400 };
  }

  // Формат: base64url(payload):base64url(signature)
  // payload содержит двоеточия (userID:tenantID:timestamp),
  // поэтому разделяем по ПОСЛЕДНЕМУ двоеточию
  const lastColon = tokenParam.lastIndexOf(':');
  if (lastColon <= 0) {
    return { error: 'Invalid token format', status: 400 };
  }

  const payloadB64 = tokenParam.substring(0, lastColon);
  const signatureB64 = tokenParam.substring(lastColon + 1);

  if (!payloadB64 || !signatureB64) {
    return { error: 'Invalid token format', status: 400 };
  }

  // Декодируем base64url
  let payload, signature;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    signature = Buffer.from(signatureB64, 'base64url');
  } catch (e) {
    return { error: 'Invalid token encoding', status: 400 };
  }

  // Проверяем HMAC-SHA256 подпись
  const expectedSig = crypto
    .createHmac('sha256', dashboardToken)
    .update(payload)
    .digest();

  if (signature.length !== expectedSig.length ||
      !crypto.timingSafeEqual(signature, expectedSig)) {
    return { error: 'Invalid signature', status: 401 };
  }

  // Парсим payload: userID:tenantID:tier:timestamp (или userID:tenantID:timestamp для обратной совместимости)
  const parts = payload.split(':');
  let userID, tenantID, tier, tsStr;
  if (parts.length === 4) {
    [userID, tenantID, tier, tsStr] = parts;
  } else if (parts.length === 3) {
    [userID, tenantID, tsStr] = parts;
    tier = 'free';
  } else {
    return { error: 'Invalid payload format', status: 400 };
  }

  const timestamp = parseInt(tsStr, 10);
  if (isNaN(timestamp)) {
    return { error: 'Invalid timestamp', status: 400 };
  }

  // Проверяем время жизни
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > SSO_MAX_AGE_SECONDS) {
    return { error: 'Token expired', status: 401 };
  }

  return { ok: true, userID, tenantID, tier, timestamp };
}

// --- Express handler ---

function ssoHandler(req, res) {
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

  if (!DASHBOARD_TOKEN) {
    // Без токена авторизация отключена — просто редирект
    return res.redirect('/');
  }

  const result = verifySsoToken(req.query.token, DASHBOARD_TOKEN);

  if (result.error) {
    return res.status(result.status).send(ssoErrorPage(result.error));
  }

  // Сохраняем tier в /shared/tier.json
  tierLimits.setTier(result.tier);

  // Разрешаем inline script для SSO success page (основной CSP middleware блокирует)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'");
  res.send(ssoSuccessPage(DASHBOARD_TOKEN, result.tier));
}

module.exports = ssoHandler;
module.exports.verifySsoToken = verifySsoToken;
module.exports.ssoErrorPage = ssoErrorPage;
module.exports.ssoSuccessPage = ssoSuccessPage;

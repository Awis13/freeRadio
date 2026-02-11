const fs = require('fs');
const crypto = require('crypto');

const KEYS_FILE = '/shared/stream_keys.enc';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('stream-keys', 'utf8');

// Get encryption key from env or use fixed fallback
function getKey() {
  const envKey = process.env.STREAM_KEYS_SECRET;
  if (envKey) {
    return crypto.createHash('sha256').update(envKey).digest();
  }
  // Fixed fallback key (consistent across restarts)
  return crypto.createHash('sha256').update('SYSTEM23_STREAM_KEYS_v1').digest();
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v2', iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptV2(parts) {
  if (parts.length !== 4 || parts[0] !== 'v2') return null;
  const key = getKey();
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const encrypted = Buffer.from(parts[3], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Backward compatibility for existing v1 records created with crypto.createCipher/createDecipher.
function decryptLegacy(parts) {
  if (parts.length !== 3) return null;
  const key = getKey();
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipher(ALGORITHM, key);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function decrypt(encryptedData) {
  const parts = encryptedData.split(':');
  try {
    const v2 = decryptV2(parts);
    if (v2 !== null) return v2;
    return decryptLegacy(parts);
  } catch (e) {
    return null;
  }
}

function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) {
      return { platforms: {} };
    }
    const encrypted = fs.readFileSync(KEYS_FILE, 'utf8');
    const decrypted = decrypt(encrypted);
    if (!decrypted) {
      return { platforms: {} };
    }
    const parsed = JSON.parse(decrypted);
    if (!encrypted.startsWith('v2:')) {
      saveKeys(parsed);
    }
    return parsed;
  } catch (e) {
    return { platforms: {} };
  }
}

function saveKeys(data) {
  const json = JSON.stringify(data);
  const encrypted = encrypt(json);
  fs.writeFileSync(KEYS_FILE, encrypted);
}

function getPlatforms() {
  const data = loadKeys();
  // Return list without actual keys (masked)
  const platforms = {};
  for (const [name, config] of Object.entries(data.platforms)) {
    platforms[name] = {
      enabled: config.enabled,
      keyMask: config.streamKey ? '****' + config.streamKey.slice(-4) : null,
      rtmpUrl: config.rtmpUrl
    };
  }
  return platforms;
}

function getPlatformConfig(name) {
  const data = loadKeys();
  return data.platforms[name] || null;
}

function setPlatform(name, config) {
  const data = loadKeys();
  data.platforms[name] = {
    enabled: config.enabled,
    streamKey: config.streamKey,
    rtmpUrl: config.rtmpUrl
  };
  saveKeys(data);
}

function setPlatformEnabled(name, enabled) {
  const data = loadKeys();
  if (!data.platforms[name]) {
    return null;
  }
  data.platforms[name].enabled = Boolean(enabled);
  saveKeys(data);
  return { name, enabled: data.platforms[name].enabled };
}

function deletePlatform(name) {
  const data = loadKeys();
  delete data.platforms[name];
  saveKeys(data);
}

function buildRtmpUrl(rtmpUrl, streamKey) {
  const key = String(streamKey || '').trim();
  const base = String(rtmpUrl || '').trim();
  if (!base || !key) return null;

  if (base.includes('{key}') || base.includes('{streamKey}')) {
    return base
      .replace(/\{key\}/g, key)
      .replace(/\{streamKey\}/g, key);
  }

  try {
    const parsed = new URL(base);
    const host = (parsed.hostname || '').toLowerCase();
    const isKick = host.endsWith('live-video.net');
    let pathname = parsed.pathname || '/';

    if (pathname.includes(key)) {
      return parsed.toString();
    }

    if (isKick) {
      pathname = pathname.replace(/\/+$/, '');
      if (!pathname || pathname === '/') pathname = '/app';
      if (!pathname.endsWith('/app')) pathname += '/app';
      parsed.pathname = `${pathname}/${key}`;
      return parsed.toString();
    }

    pathname = pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') pathname = '';
    parsed.pathname = `${pathname}/${key}`;
    return parsed.toString();
  } catch (e) {
    // Fallback for malformed URLs: keep legacy behavior without forcing /app.
    let safeBase = base;
    if (!safeBase.endsWith('/')) safeBase += '/';
    return safeBase + key;
  }
}

function getEnabledRtmpUrls() {
  const data = loadKeys();
  const urls = [];
  for (const [name, config] of Object.entries(data.platforms)) {
    if (config.enabled && config.streamKey && config.rtmpUrl) {
      const url = buildRtmpUrl(config.rtmpUrl, config.streamKey);
      if (url) urls.push({ name, url });
    }
  }
  return urls;
}

module.exports = {
  getPlatforms,
  getPlatformConfig,
  setPlatform,
  setPlatformEnabled,
  deletePlatform,
  getEnabledRtmpUrls
};

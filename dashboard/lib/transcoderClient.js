const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Конфигурация из env
const TRANSCODER_URL = process.env.TRANSCODER_URL || '';
const TRANSCODER_TOKEN = process.env.TRANSCODER_TOKEN || '';
const TENANT_ID = process.env.TENANT_ID || 'default';

const ENABLED = !!(TRANSCODER_URL && TRANSCODER_TOKEN);

if (ENABLED) {
  console.log(`[transcoder] клиент включён: ${TRANSCODER_URL}, tenant=${TENANT_ID}`);
} else {
  console.log('[transcoder] клиент выключен (нет TRANSCODER_URL или TRANSCODER_TOKEN)');
}

// Отправляет файл на транскодер. Возвращает { job_id, status, filename }.
async function submit(filePath) {
  if (!ENABLED) return null;

  const filename = path.basename(filePath);
  const boundary = '----S23Boundary' + Date.now().toString(36);

  // Формируем multipart body вручную (без зависимостей)
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileStat = fs.statSync(filePath);
  const totalLength = header.length + fileStat.size + footer.length;

  const url = new URL('/api/v1/transcode', TRANSCODER_URL);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalLength,
          'X-Tenant-ID': TENANT_ID,
          Authorization: `Bearer ${TRANSCODER_TOKEN}`,
        },
        timeout: 300000, // 5 минут на загрузку
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`невалидный JSON от транскодера: ${data}`));
            }
          } else {
            reject(new Error(`транскодер вернул ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('таймаут подключения к транскодеру'));
    });

    // Отправляем multipart: header → файл → footer
    req.write(header);
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', reject);
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => {
      req.end(footer);
    });
  });
}

// Получить статус задачи
async function getJob(jobId) {
  if (!ENABLED) return null;

  const url = new URL(`/api/v1/jobs/${jobId}`, TRANSCODER_URL);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.get(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        headers: { Authorization: `Bearer ${TRANSCODER_TOKEN}` },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`невалидный JSON: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('таймаут'));
    });
  });
}

module.exports = { submit, getJob, ENABLED, TENANT_ID };

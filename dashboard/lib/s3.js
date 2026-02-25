const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// Конфигурация через env vars
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET || 'studio23';
const S3_REGION = process.env.S3_REGION || 'eu-central-1';
const TENANT_ID = process.env.TENANT_ID || 'default';
const S3_ENABLED = process.env.S3_ENABLED === 'true';

let client = null;

function getClient() {
  if (!client && S3_ENABLED && S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY) {
    client = new S3Client({
      endpoint: S3_ENDPOINT.startsWith('http') ? S3_ENDPOINT : `https://${S3_ENDPOINT}`,
      region: S3_REGION,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      forcePathStyle: true
    });
  }
  return client;
}

// Полный S3 ключ с tenant prefix
function tenantKey(key) {
  return `tenants/${TENANT_ID}/${key}`;
}

// Stream upload
async function upload(localPath, s3Key) {
  const s3 = getClient();
  if (!s3) return;
  const body = fs.createReadStream(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: tenantKey(s3Key),
    Body: body
  }));
  console.log(`[s3] uploaded ${s3Key}`);
}

// Stream download + atomic rename
async function download(s3Key, localPath) {
  const s3 = getClient();
  if (!s3) return;
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = localPath + '.s3tmp';
  const res = await s3.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: tenantKey(s3Key)
  }));
  await pipeline(res.Body, fs.createWriteStream(tmpPath));
  fs.renameSync(tmpPath, localPath);
  console.log(`[s3] downloaded ${s3Key} → ${localPath}`);
}

// List objects by prefix
async function list(prefix) {
  const s3 = getClient();
  if (!s3) return [];
  const fullPrefix = tenantKey(prefix);
  const result = [];
  let continuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: fullPrefix,
      ContinuationToken: continuationToken
    }));
    if (res.Contents) {
      for (const obj of res.Contents) {
        // Убираем tenant prefix из ключа
        result.push({
          key: obj.Key.slice(fullPrefix.length - prefix.length),
          size: obj.Size,
          modified: obj.LastModified
        });
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return result;
}

// Delete object
async function remove(s3Key) {
  const s3 = getClient();
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({
    Bucket: S3_BUCKET,
    Key: tenantKey(s3Key)
  }));
  console.log(`[s3] deleted ${s3Key}`);
}

// Head object — проверить существование
async function exists(s3Key) {
  const s3 = getClient();
  if (!s3) return false;
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: tenantKey(s3Key)
    }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

// Скачать если нет локально
async function ensureCached(s3Key, localPath) {
  if (fs.existsSync(localPath)) return;
  await download(s3Key, localPath);
}

// Скачать все недостающие файлы из S3 prefix в локальную директорию
async function syncDir(s3Prefix, localDir) {
  const objects = await list(s3Prefix);
  let downloaded = 0;
  for (const obj of objects) {
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath || relativePath.endsWith('/')) continue;
    const localPath = path.join(localDir, relativePath);
    if (!fs.existsSync(localPath)) {
      try {
        await download(s3Prefix + relativePath, localPath);
        downloaded++;
      } catch (e) {
        console.error(`[s3] sync failed for ${relativePath}: ${e.message}`);
      }
    }
  }
  if (downloaded > 0) console.log(`[s3] synced ${downloaded} files to ${localDir}`);
  return downloaded;
}

module.exports = {
  upload, download, list, remove, exists,
  ensureCached, syncDir, tenantKey,
  S3_ENABLED, TENANT_ID
};

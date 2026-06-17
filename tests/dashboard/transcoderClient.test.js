/**
 * tests/dashboard/transcoderClient.test.js
 *
 * Wire-level characterization of dashboard/lib/transcoderClient.js (P1-6).
 *
 * Strategy: transcoderClient bakes TRANSCODER_URL/TRANSCODER_TOKEN/
 * TENANT_ID and the derived ENABLED flag into module-level consts at
 * require time. vi.mock() is inert for CJS-internal requires here, so we
 * fresh-require the module with env baked in (cache-deleted) and talk to a
 * REAL loopback http server that records method/path/headers/raw body and
 * answers per-test. A real temp file feeds submit()'s file stream.
 *
 * Pinned here (current behavior):
 *   - submit()/getJob() return null when !ENABLED (URL or TOKEN unset);
 *   - submit() multipart wire: POST /api/v1/transcode, Authorization
 *     Bearer, X-Tenant-ID, multipart/form-data boundary; body framing is
 *     header + file bytes + footer, Content-Length = sum; 2xx JSON resolves
 *     the parsed object, non-2xx rejects ("transcoder returned N"),
 *     non-JSON 2xx rejects ("invalid JSON from transcoder");
 *   - getJob() GET /api/v1/jobs/<id>, Authorization Bearer; NO status-code
 *     check — it resolves the parsed JSON regardless of statusCode (quirk),
 *     rejects only on non-JSON; 10s timeout -> Error('timeout').
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const TR_SPEC = '../../dashboard/lib/transcoderClient';

const ENV_KEYS = ['TRANSCODER_URL', 'TRANSCODER_TOKEN', 'TENANT_ID'];
const ORIGINAL_ENV = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
}

/** Fresh-require transcoderClient with env baked from args. */
function freshTr({ url, token, tenant }) {
  if (url === undefined) delete process.env.TRANSCODER_URL; else process.env.TRANSCODER_URL = url;
  if (token === undefined) delete process.env.TRANSCODER_TOKEN; else process.env.TRANSCODER_TOKEN = token;
  if (tenant === undefined) delete process.env.TENANT_ID; else process.env.TENANT_ID = tenant;
  delete nodeRequire.cache[nodeRequire.resolve(TR_SPEC)];
  return nodeRequire(TR_SPEC);
}

let server;
let lastReq;
let responder;
let tmpFile;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastReq = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks)
      };
      responder(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tmpFile = path.join(os.tmpdir(), 'transcoder-test-' + Date.now() + '.mov');
  fs.writeFileSync(tmpFile, Buffer.from('PCMFILEBYTES'));
});

afterAll(async () => {
  http.globalAgent.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  delete nodeRequire.cache[nodeRequire.resolve(TR_SPEC)];
  restoreEnv();
  vi.restoreAllMocks();
});

function baseUrl() {
  return `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
  lastReq = undefined;
  responder = (req, res) => { res.statusCode = 200; res.end('{"ok":true}'); };
});

describe('dashboard/lib/transcoderClient.js ENABLED flag', () => {
  it('disabled when URL missing: submit/getJob return null, ENABLED false', async () => {
    const tr = freshTr({ url: '', token: 'tok' });
    expect(tr.ENABLED).toBe(false);
    expect(await tr.submit('/some/file.mov')).toBeNull();
    expect(await tr.getJob('J1')).toBeNull();
  });

  it('disabled when TOKEN missing', async () => {
    const tr = freshTr({ url: baseUrl(), token: '' });
    expect(tr.ENABLED).toBe(false);
    expect(await tr.submit(tmpFile)).toBeNull();
  });

  it('enabled when both URL and TOKEN set; TENANT_ID defaults to "default"', () => {
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    expect(tr.ENABLED).toBe(true);
    expect(tr.TENANT_ID).toBe('default');
  });
});

describe('dashboard/lib/transcoderClient.js submit() wire format', () => {
  it('sends a well-framed multipart POST and resolves the 2xx JSON', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'sekret', tenant: 'tenant-9' });
    responder = (req, res) => { res.statusCode = 201; res.end('{"job_id":"J9","status":"queued"}'); };

    const result = await tr.submit(tmpFile);
    expect(result).toEqual({ job_id: 'J9', status: 'queued' });

    expect(lastReq.method).toBe('POST');
    expect(lastReq.url).toBe('/api/v1/transcode');
    expect(lastReq.headers.authorization).toBe('Bearer sekret');
    expect(lastReq.headers['x-tenant-id']).toBe('tenant-9');

    // Boundary captured from the received Content-Type.
    const ct = lastReq.headers['content-type'];
    expect(ct).toMatch(/^multipart\/form-data; boundary=----S23Boundary/);
    const boundary = ct.split('boundary=')[1];

    const body = lastReq.body.toString('binary');
    const filename = path.basename(tmpFile);
    // Header framing.
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body).toContain(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
    expect(body).toContain('Content-Type: application/octet-stream\r\n\r\n');
    // File bytes are present between header and footer.
    expect(body).toContain('PCMFILEBYTES');
    // Footer framing.
    expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);

    // Content-Length = header + file + footer (exact byte sum).
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileSize = fs.statSync(tmpFile).size;
    expect(lastReq.headers['content-length']).toBe(String(header.length + fileSize + footer.length));
    expect(lastReq.body.length).toBe(header.length + fileSize + footer.length);
  });

  it('non-2xx -> rejects with "transcoder returned N"', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    responder = (req, res) => { res.statusCode = 500; res.end('server error'); };
    await expect(tr.submit(tmpFile)).rejects.toThrow('transcoder returned 500: server error');
  });

  it('2xx non-JSON -> rejects with "invalid JSON from transcoder"', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    responder = (req, res) => { res.statusCode = 200; res.end('not json'); };
    await expect(tr.submit(tmpFile)).rejects.toThrow('invalid JSON from transcoder: not json');
  });
});

describe('dashboard/lib/transcoderClient.js getJob()', () => {
  it('GET /api/v1/jobs/<id> with bearer; resolves JSON on 200', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'jtok' });
    responder = (req, res) => { res.statusCode = 200; res.end('{"status":"done"}'); };
    const job = await tr.getJob('ABC');
    expect(job).toEqual({ status: 'done' });
    expect(lastReq.method).toBe('GET');
    expect(lastReq.url).toBe('/api/v1/jobs/ABC');
    expect(lastReq.headers.authorization).toBe('Bearer jtok');
  });

  it('QUIRK: NO status-code check — resolves JSON even on a 500', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    responder = (req, res) => { res.statusCode = 500; res.end('{"status":"error"}'); };
    await expect(tr.getJob('ABC')).resolves.toEqual({ status: 'error' });
  });

  it('non-JSON body -> rejects with "invalid JSON"', async () => {
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    responder = (req, res) => { res.statusCode = 200; res.end('<html>oops</html>'); };
    await expect(tr.getJob('ABC')).rejects.toThrow('invalid JSON: <html>oops</html>');
  });

  it('timeout -> req.destroy() + rejects with Error("timeout")', async () => {
    // getJob hardcodes a 10s socket timeout (no env override), so a real wait
    // is too slow. Spy on the shared http.get the module uses and synthesize
    // the 'timeout' event the same way Node would, then pin the destroy + the
    // exact reject message. The 'timeout' option of 10000 is passed through.
    const tr = freshTr({ url: baseUrl(), token: 'tok' });
    let seenTimeoutOption;
    const destroy = vi.fn();
    const handlers = {};
    const reqStub = {
      on: (event, cb) => { handlers[event] = cb; return reqStub; },
      destroy
    };
    const getSpy = vi.spyOn(http, 'get').mockImplementation((opts) => {
      seenTimeoutOption = opts.timeout;
      // Fire the timeout handler asynchronously, as Node would.
      setImmediate(() => handlers.timeout && handlers.timeout());
      return reqStub;
    });

    await expect(tr.getJob('SLOW')).rejects.toThrow('timeout');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(seenTimeoutOption).toBe(10000);
    getSpy.mockRestore();
  });
});

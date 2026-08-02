/**
 * tests/dashboard/s3.test.js
 *
 * Characterization of dashboard/lib/s3.js (P1-4).
 *
 * Strategy: s3.js is CJS with module-level consts FROZEN at require time
 * from env (endpoint/keys/bucket/region/tenant/enabled flag) and a lazy
 * module-private S3Client singleton. So each test:
 *   1. sets env BEFORE a fresh require (cache-deleted) of s3.js;
 *   2. injects a stub client through s3.js's own _setClientFactory seam,
 *      with a per-test responder keyed on the command type + input.
 *
 * Nothing here touches the AWS SDK's internals. The stub is a plain
 * object with a send() method, and the commands are identified with
 * `instanceof` against the classes @aws-sdk/client-s3 exports publicly —
 * so an SDK upgrade that reshapes the client internally (which is what
 * broke the previous prototype-spy version of this file) cannot break
 * these tests. What they DO couple to: that s3.js calls `send(command)`
 * on whatever getClient() returns, and the public command classes.
 *
 * Pinned here (current behavior, callers depend on it):
 *   - tenantKey(): `tenants/${TENANT_ID}/${key}` with TENANT_ID baked
 *     from env at require time (default 'default');
 *   - list(): Prefix = tenantKey(prefix); returned keys are sliced with
 *     `fullPrefix.length - prefix.length` — i.e. ONLY the tenant part is
 *     stripped, the caller's prefix STAYS in the key (syncWatcher and
 *     syncDir arithmetic depend on exactly this); do-while pagination via
 *     NextContinuationToken; empty/missing Contents -> [];
 *   - exists(): true on HEAD success; false on e.name === 'NotFound' OR
 *     e.$metadata.httpStatusCode === 404; any other error RETHROWN;
 *   - download(): streams to `${localPath}.s3tmp` then renameSync swap;
 *     creates parent dir recursively; on mid-stream Body error the
 *     promise rejects, localPath is NEVER created, and the .s3tmp file
 *     REMAINS on disk (verified empirically — no cleanup; how much
 *     partial data it holds is flush-timing dependent, so only its
 *     existence is pinned);
 *   - syncDir(): relativePath = obj.key.slice(s3Prefix.length) (works
 *     because list keeps the caller prefix), skips empty/dir-marker
 *     entries, downloads ONLY locally-missing files, swallows per-file
 *     download errors, returns the downloaded count;
 *   - upload/uploadBuffer/remove: Bucket from env (default 'studio23'),
 *     Key tenant-prefixed, Body = file read stream / verbatim buffer;
 *   - ensureCached(): skips the SDK entirely when localPath exists;
 *   - disabled mode (S3_ENABLED unset, or enabled but no endpoint):
 *     getClient() stays null -> list [] / exists false / syncDir 0 /
 *     upload/uploadBuffer/download/remove resolve undefined, zero SDK
 *     calls.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const nodeRequire = createRequire(import.meta.url);
const S3_SPEC = '../../dashboard/lib/s3';

// Public command classes — the only part of the SDK these tests know about.
const {
  PutObjectCommand, GetObjectCommand, ListObjectsV2Command,
  DeleteObjectCommand, HeadObjectCommand
} = nodeRequire('@aws-sdk/client-s3');

const ENV_KEYS = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION', 'TENANT_ID', 'S3_ENABLED'];
const ORIGINAL_ENV = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function restoreOriginalEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENABLED_ENV = {
  S3_ENABLED: 'true',
  S3_ENDPOINT: 'http://127.0.0.1:9',
  S3_ACCESS_KEY: 'test-access',
  S3_SECRET_KEY: 'test-secret'
};

/** The module instance the last freshS3() produced, for mockSend to inject into. */
let currentS3 = null;

/** The factory stub the last mockSend() installed — never called in disabled mode. */
let clientFactory = null;

/** Fresh require of s3.js with exactly the given env baked in. */
function freshS3(env = ENABLED_ENV) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
  currentS3 = nodeRequire(S3_SPEC);
  return currentS3;
}

/**
 * Hand the freshly required s3.js a stub client whose send() runs `responder`,
 * and return that send spy. The module's gate decides whether the factory is
 * ever called, so a disabled module still builds nothing.
 */
function mockSend(responder) {
  const send = vi.fn(async (cmd) => responder(cmd));
  clientFactory = vi.fn(() => ({ send }));
  currentS3._setClientFactory(clientFactory);
  return send;
}

/** Command classes by name, for readable assertions on what was sent. */
const COMMANDS = new Map([
  [PutObjectCommand, 'PutObjectCommand'],
  [GetObjectCommand, 'GetObjectCommand'],
  [ListObjectsV2Command, 'ListObjectsV2Command'],
  [DeleteObjectCommand, 'DeleteObjectCommand'],
  [HeadObjectCommand, 'HeadObjectCommand'],
]);

/** Identify a command by `instanceof` against the SDK's public exports. */
function commandName(cmd) {
  for (const [Cls, name] of COMMANDS) {
    if (cmd instanceof Cls) return name;
  }
  return `unknown command (${cmd && cmd.constructor && cmd.constructor.name})`;
}

/** Calls made to the send spy as [commandName, input] pairs. */
function sentCommands(sendSpy) {
  return sendSpy.mock.calls.map(([cmd]) => [commandName(cmd), cmd.input]);
}

let tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3test-'));
  tmpDirs.push(dir);
  return dir;
}

describe('dashboard/lib/s3.js', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Drop the injected factory too: without this a test that forgets to call
    // mockSend() reads the PREVIOUS test's spy and asserts against stale calls
    // instead of failing.
    clientFactory = null;
    delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
    restoreOriginalEnv();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  afterAll(() => {
    delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
    restoreOriginalEnv();
  });

  // ─── tenantKey ───────────────────────────────────────────────

  describe('tenantKey', () => {
    it('prefixes with tenants/default/ when TENANT_ID is unset', () => {
      const s3 = freshS3();
      expect(s3.tenantKey('music/processed/song.wav')).toBe('tenants/default/music/processed/song.wav');
      expect(s3.TENANT_ID).toBe('default');
    });

    it('bakes a custom TENANT_ID from env at require time', () => {
      const s3 = freshS3({ ...ENABLED_ENV, TENANT_ID: 'acme' });
      expect(s3.tenantKey('config/playlists.json')).toBe('tenants/acme/config/playlists.json');
      expect(s3.TENANT_ID).toBe('acme');
    });
  });

  // ─── client construction ─────────────────────────────────────

  describe('client construction', () => {
    it('builds the client lazily and only once, reusing it across calls', async () => {
      const s3 = freshS3();
      const send = mockSend(() => ({}));

      // Nothing built until the first operation needs a client.
      expect(clientFactory).not.toHaveBeenCalled();

      await s3.uploadBuffer(Buffer.from('a'), 'config/a.json');
      await s3.uploadBuffer(Buffer.from('b'), 'config/b.json');
      await s3.remove('config/a.json');

      // Lazy singleton: one client, three sends through it.
      expect(clientFactory).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(3);
    });
  });

  // ─── list ────────────────────────────────────────────────────

  describe('list', () => {
    it('strips ONLY the tenant part — caller prefix stays in returned keys', async () => {
      const s3 = freshS3();
      const modified = new Date('2026-01-01T00:00:00Z');
      const send = mockSend(() => ({
        Contents: [{ Key: 'tenants/default/music/processed/song.wav', Size: 1234, LastModified: modified }]
      }));

      const result = await s3.list('music/processed/');

      expect(result).toEqual([{ key: 'music/processed/song.wav', size: 1234, modified }]);
      const [[name, input]] = sentCommands(send);
      expect(name).toBe('ListObjectsV2Command');
      expect(input.Bucket).toBe('studio23');
      expect(input.Prefix).toBe('tenants/default/music/processed/');
      expect(input.ContinuationToken).toBeUndefined();
    });

    it('paginates with ContinuationToken and concatenates pages in order', async () => {
      const s3 = freshS3();
      const send = mockSend((cmd) => {
        if (!cmd.input.ContinuationToken) {
          return {
            Contents: [{ Key: 'tenants/default/music/raw/a.mp3', Size: 1, LastModified: null }],
            NextContinuationToken: 'tok-page-2'
          };
        }
        return {
          Contents: [{ Key: 'tenants/default/music/raw/b.mp3', Size: 2, LastModified: null }]
        };
      });

      const result = await s3.list('music/raw/');

      expect(result.map(o => o.key)).toEqual(['music/raw/a.mp3', 'music/raw/b.mp3']);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0].input.ContinuationToken).toBe('tok-page-2');
    });

    it('returns [] when the response has no Contents', async () => {
      const s3 = freshS3();
      mockSend(() => ({}));
      expect(await s3.list('music/processed/')).toEqual([]);
    });
  });

  // ─── exists ──────────────────────────────────────────────────

  describe('exists', () => {
    it('returns true when HeadObject succeeds', async () => {
      const s3 = freshS3();
      const send = mockSend(() => ({}));
      expect(await s3.exists('config/playlists.json')).toBe(true);
      const [[name, input]] = sentCommands(send);
      expect(name).toBe('HeadObjectCommand');
      expect(input.Key).toBe('tenants/default/config/playlists.json');
    });

    it('returns false on e.name === NotFound', async () => {
      const s3 = freshS3();
      const err = new Error('not found');
      err.name = 'NotFound';
      mockSend(() => { throw err; });
      expect(await s3.exists('config/missing.json')).toBe(false);
    });

    it('returns false on $metadata.httpStatusCode === 404', async () => {
      const s3 = freshS3();
      const err = new Error('gone');
      err.$metadata = { httpStatusCode: 404 };
      mockSend(() => { throw err; });
      expect(await s3.exists('config/missing.json')).toBe(false);
    });

    it('RETHROWS non-404 errors (e.g. 500)', async () => {
      const s3 = freshS3();
      const err = new Error('internal');
      err.name = 'InternalError';
      err.$metadata = { httpStatusCode: 500 };
      mockSend(() => { throw err; });
      await expect(s3.exists('config/playlists.json')).rejects.toBe(err);
    });
  });

  // ─── download ────────────────────────────────────────────────

  describe('download', () => {
    it('streams to .s3tmp then atomically renames; creates parent dirs', async () => {
      const s3 = freshS3();
      const dir = makeTmpDir();
      const localPath = path.join(dir, 'nested', 'deeper', 'config.json');
      const send = mockSend(() => ({ Body: Readable.from(['hello-from-s3']) }));

      await s3.download('config/config.json', localPath);

      expect(fs.readFileSync(localPath, 'utf8')).toBe('hello-from-s3');
      expect(fs.existsSync(localPath + '.s3tmp')).toBe(false);
      const [[name, input]] = sentCommands(send);
      expect(name).toBe('GetObjectCommand');
      expect(input.Bucket).toBe('studio23');
      expect(input.Key).toBe('tenants/default/config/config.json');
    });

    it('mid-stream error: rejects, localPath never created, orphan .s3tmp remains', async () => {
      const s3 = freshS3();
      const dir = makeTmpDir();
      const localPath = path.join(dir, 'broken.bin');
      mockSend(() => {
        const body = new Readable({ read() {} });
        body.push('partial');
        setImmediate(() => body.destroy(new Error('mid-stream boom')));
        return { Body: body };
      });

      await expect(s3.download('music/raw/broken.bin', localPath)).rejects.toThrow('mid-stream boom');

      // Atomicity pin: the final path is never created on failure...
      expect(fs.existsSync(localPath)).toBe(false);
      // ...but the tmp file is LEFT BEHIND (no cleanup today). Its content
      // is flush-timing dependent, so only existence is pinned.
      expect(fs.existsSync(localPath + '.s3tmp')).toBe(true);
    });
  });

  // ─── upload / uploadBuffer / remove ──────────────────────────

  describe('upload / uploadBuffer / remove', () => {
    it('upload sends PutObject with tenant key and a read stream of localPath', async () => {
      const s3 = freshS3();
      const dir = makeTmpDir();
      const localPath = path.join(dir, 'track.mp3');
      fs.writeFileSync(localPath, 'audio-bytes');
      const send = mockSend(() => ({}));

      await s3.upload(localPath, 'music/raw/track.mp3');

      const [[name, input]] = sentCommands(send);
      expect(name).toBe('PutObjectCommand');
      expect(input.Bucket).toBe('studio23');
      expect(input.Key).toBe('tenants/default/music/raw/track.mp3');
      expect(input.Body).toBeInstanceOf(fs.ReadStream);
      expect(input.Body.path).toBe(localPath);
      // Settle the stream before the tmpdir is removed, otherwise its
      // async open races the cleanup and throws an uncaught ENOENT.
      input.Body.destroy();
      await new Promise(resolve => input.Body.on('close', resolve));
    });

    it('uploadBuffer sends the buffer verbatim as Body', async () => {
      const s3 = freshS3();
      const buf = Buffer.from('{"a":1}');
      const send = mockSend(() => ({}));

      await s3.uploadBuffer(buf, 'config/playlists.json');

      const [[name, input]] = sentCommands(send);
      expect(name).toBe('PutObjectCommand');
      expect(input.Key).toBe('tenants/default/config/playlists.json');
      expect(input.Body).toBe(buf);
    });

    it('remove sends DeleteObject with the tenant key', async () => {
      const s3 = freshS3();
      const send = mockSend(() => ({}));

      await s3.remove('music/raw/old.mp3');

      const [[name, input]] = sentCommands(send);
      expect(name).toBe('DeleteObjectCommand');
      expect(input.Bucket).toBe('studio23');
      expect(input.Key).toBe('tenants/default/music/raw/old.mp3');
    });

    it('S3_BUCKET env overrides the default bucket', async () => {
      const s3 = freshS3({ ...ENABLED_ENV, S3_BUCKET: 'custom-bucket' });
      const send = mockSend(() => ({}));
      await s3.uploadBuffer(Buffer.from('x'), 'config/x.json');
      expect(send.mock.calls[0][0].input.Bucket).toBe('custom-bucket');
    });
  });

  // ─── ensureCached ────────────────────────────────────────────

  describe('ensureCached', () => {
    it('skips the SDK entirely when the local file already exists', async () => {
      const s3 = freshS3();
      const dir = makeTmpDir();
      const localPath = path.join(dir, 'cached.wav');
      fs.writeFileSync(localPath, 'already-here');
      const send = mockSend(() => ({}));

      await s3.ensureCached('music/processed/cached.wav', localPath);

      expect(send).not.toHaveBeenCalled();
      expect(fs.readFileSync(localPath, 'utf8')).toBe('already-here');
    });

    it('downloads when the local file is missing', async () => {
      const s3 = freshS3();
      const dir = makeTmpDir();
      const localPath = path.join(dir, 'fetched.wav');
      const send = mockSend(() => ({ Body: Readable.from(['fresh']) }));

      await s3.ensureCached('music/processed/fetched.wav', localPath);

      expect(send).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(localPath, 'utf8')).toBe('fresh');
    });
  });

  // ─── syncDir ─────────────────────────────────────────────────

  describe('syncDir', () => {
    it('downloads only missing files, skips dir markers, joins relative paths (double-slice)', async () => {
      const s3 = freshS3();
      const localDir = makeTmpDir();
      fs.writeFileSync(path.join(localDir, 'a.mp3'), 'local-copy');
      const send = mockSend((cmd) => {
        if (cmd instanceof ListObjectsV2Command) {
          return {
            Contents: [
              { Key: 'tenants/default/music/raw/', Size: 0, LastModified: null },
              { Key: 'tenants/default/music/raw/a.mp3', Size: 3, LastModified: null },
              { Key: 'tenants/default/music/raw/sub/b.mp3', Size: 4, LastModified: null }
            ]
          };
        }
        return { Body: Readable.from(['downloaded-bytes']) };
      });

      const count = await s3.syncDir('music/raw/', localDir);

      expect(count).toBe(1);
      // Existing local file untouched.
      expect(fs.readFileSync(path.join(localDir, 'a.mp3'), 'utf8')).toBe('local-copy');
      // Missing file downloaded into the joined relative path.
      expect(fs.readFileSync(path.join(localDir, 'sub', 'b.mp3'), 'utf8')).toBe('downloaded-bytes');
      // The GetObject key is prefix + relativePath, re-tenant-prefixed.
      const getCalls = sentCommands(send).filter(([n]) => n === 'GetObjectCommand');
      expect(getCalls).toEqual([
        ['GetObjectCommand', expect.objectContaining({ Key: 'tenants/default/music/raw/sub/b.mp3' })]
      ]);
    });

    it('swallows per-file download errors and returns 0', async () => {
      const s3 = freshS3();
      const localDir = makeTmpDir();
      mockSend((cmd) => {
        if (cmd instanceof ListObjectsV2Command) {
          return { Contents: [{ Key: 'tenants/default/music/raw/bad.mp3', Size: 1, LastModified: null }] };
        }
        throw new Error('get failed');
      });

      await expect(s3.syncDir('music/raw/', localDir)).resolves.toBe(0);
      expect(fs.existsSync(path.join(localDir, 'bad.mp3'))).toBe(false);
    });
  });

  // ─── Disabled mode ───────────────────────────────────────────

  describe('disabled mode', () => {
    it('S3_ENABLED unset: every function no-ops without touching the SDK', async () => {
      const s3 = freshS3({
        S3_ENDPOINT: 'http://127.0.0.1:9',
        S3_ACCESS_KEY: 'k',
        S3_SECRET_KEY: 's'
        // S3_ENABLED deliberately absent
      });
      const send = mockSend(() => ({}));
      const dir = makeTmpDir();
      const missingPath = path.join(dir, 'nope.wav');

      expect(s3.S3_ENABLED).toBe(false);
      expect(await s3.list('music/processed/')).toEqual([]);
      expect(await s3.exists('config/playlists.json')).toBe(false);
      expect(await s3.upload(missingPath, 'music/raw/x.mp3')).toBeUndefined();
      expect(await s3.uploadBuffer(Buffer.from('x'), 'config/x.json')).toBeUndefined();
      expect(await s3.download('config/x.json', missingPath)).toBeUndefined();
      expect(await s3.remove('config/x.json')).toBeUndefined();
      expect(await s3.ensureCached('music/processed/nope.wav', missingPath)).toBeUndefined();
      expect(await s3.syncDir('music/raw/', dir)).toBe(0);

      expect(send).not.toHaveBeenCalled();
      // Stronger than "no calls": the gate never even asked for a client.
      expect(clientFactory).not.toHaveBeenCalled();
      expect(fs.existsSync(missingPath)).toBe(false);
    });

    it('S3_ENABLED=true but endpoint missing: client never builds, still no-ops', async () => {
      const s3 = freshS3({ S3_ENABLED: 'true', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' });
      const send = mockSend(() => ({}));

      expect(s3.S3_ENABLED).toBe(true);
      expect(await s3.list('music/processed/')).toEqual([]);
      expect(await s3.exists('x')).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(clientFactory).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// clientConfig / defaultClientFactory
// ---------------------------------------------------------------------------
//
// The real factory is the one block these tests never reached: every other case
// injects a stub through _setClientFactory, so the config the module would hand
// a live S3Client was unasserted. clientConfig() was split out of
// defaultClientFactory for exactly this (T18-C1) — same composition, callable
// without constructing a client.

describe('clientConfig', () => {
  it('leaves an endpoint that already carries a scheme alone', () => {
    const s3 = freshS3({ ...ENABLED_ENV, S3_ENDPOINT: 'http://minio.internal:9000' });
    expect(s3.clientConfig().endpoint).toBe('http://minio.internal:9000');
  });

  it('prefixes https:// onto a bare host', () => {
    // .env.example documents S3_ENDPOINT as a bare host, and the SDK rejects
    // one — this conditional is the only thing making the documented form work.
    const s3 = freshS3({ ...ENABLED_ENV, S3_ENDPOINT: 's3.eu-central-1.amazonaws.com' });
    expect(s3.clientConfig().endpoint).toBe('https://s3.eu-central-1.amazonaws.com');
  });

  it('treats https:// as already-schemed too', () => {
    const s3 = freshS3({ ...ENABLED_ENV, S3_ENDPOINT: 'https://minio.internal:9000' });
    expect(s3.clientConfig().endpoint).toBe('https://minio.internal:9000');
  });

  it('carries the credentials, region and path-style flag the module was configured with', () => {
    const s3 = freshS3({ ...ENABLED_ENV, S3_REGION: 'eu-west-1' });
    expect(s3.clientConfig()).toEqual({
      endpoint: 'http://127.0.0.1:9',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
      // Path style is required by MinIO and every other S3-compatible endpoint
      // that does not do virtual-host buckets; flipping it breaks them all.
      forcePathStyle: true,
    });
  });

  it('defaults the region when the env does not set one', () => {
    const env = { ...ENABLED_ENV };
    delete env.S3_REGION;
    const s3 = freshS3(env);
    expect(s3.clientConfig().region).toBe('eu-central-1');
  });

  it('defaultClientFactory builds a client from exactly that config', () => {
    // Constructing an S3Client performs no IO, so this stays hermetic. It
    // proves the factory and the asserted config are not two separate truths.
    const s3 = freshS3();
    const client = s3.defaultClientFactory();
    expect(typeof client.send).toBe('function');
    expect(client.config.forcePathStyle).toBe(true);
  });
});

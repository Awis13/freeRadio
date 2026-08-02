/**
 * tests/dashboard/overlay.test.js
 *
 * Characterization tests for dashboard/lib/overlay.js — pins CURRENT behavior
 * AS-IS (bugs/quirks included) before any future refactor.
 *
 * Coverage map:
 *   - loadOverlays / generateFilterString / buildDrawtext (via generateFilterString)
 *     are pure-ish fs functions, driven through an in-memory fs map.
 *   - saveOverlays is exercised indirectly through PUT /api/overlays (it writes
 *     OVERLAY_CONFIG then calls generateFilterString).
 *   - createOverlayRouter and all four endpoints are mounted REAL via supertest.
 *
 * REAL multer (not mocked): the upload endpoint uses multer DISK storage with
 * dest=/shared/overlay_assets, unreachable in this sandbox. The harness spies the
 * fs calls multer makes (mkdirp at construction, createWriteStream at upload) so
 * real multipart uploads driven with supertest .attach() resolve to req.file
 * without real disk I/O, and the handler's sanitize / traversal-guard /
 * renameSync logic runs AS-IS. express is real; nothing in overlay.js is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serverAgent } from './helpers/serverAgent.js';
import fs from 'fs';
import multer from 'multer';

import {
  installOverlayFsHarness,
  OVERLAY_CONFIG,
  FILTER_STRING_FILE,
  COMPILED_FILE,
  ASSETS_DIR,
} from './overlayHarness.js';

const { loadOverlays, generateFilterString } =
  await import('../../dashboard/lib/overlay.js');

let h;
let files;
let makeApp;
let client;
let closeServer;

beforeEach(async () => {
  vi.restoreAllMocks();
  h = installOverlayFsHarness();
  files = h.files;
  makeApp = h.makeApp;
  ({ client, close: closeServer } = await serverAgent(makeApp()));
});

afterEach(async () => {
  await closeServer();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadOverlays
// ---------------------------------------------------------------------------
describe('loadOverlays', () => {
  it('returns default when no file exists', () => {
    const config = loadOverlays();
    expect(config.enabled).toBe(false);
    expect(config.layers).toEqual([]);
  });

  it('reads config from file', () => {
    const data = { enabled: true, layers: [{ type: 'clock', enabled: true }] };
    files[OVERLAY_CONFIG] = JSON.stringify(data);
    const config = loadOverlays();
    expect(config.enabled).toBe(true);
    expect(config.layers.length).toBe(1);
  });

  it('handles corrupt JSON gracefully', () => {
    files[OVERLAY_CONFIG] = 'not json';
    const config = loadOverlays();
    expect(config.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateFilterString
// ---------------------------------------------------------------------------
describe('generateFilterString', () => {
  it('writes empty string when overlays disabled', () => {
    generateFilterString({ enabled: false, layers: [] });
    expect(files[FILTER_STRING_FILE]).toBe('');
  });

  it('writes empty string when layers array is empty', () => {
    generateFilterString({ enabled: true, layers: [] });
    expect(files[FILTER_STRING_FILE]).toBe('');
  });

  it('writes empty string when all layers disabled', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'clock', enabled: false }]
    });
    expect(files[FILTER_STRING_FILE]).toBe('');
  });

  it('generates clock drawtext filter', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'clock', enabled: true, fontsize: 48, fontcolor: 'white', x: '10', y: '10' }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('drawtext=');
    expect(filter).toContain('fontsize=48');
    expect(filter).toContain('fontcolor=white');
    expect(filter).toContain('localtime');
    expect(filter).toContain('format=yuv420p');
  });

  it('generates clock with custom format', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'clock', enabled: true, format: '%H:%M:%S' }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('%H\\:%M\\:%S');
  });

  it('generates static_text drawtext filter', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'static_text', enabled: true, text: 'STUDIO 23', fontsize: 32 }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('drawtext=');
    expect(filter).toContain("text='STUDIO 23'");
    expect(filter).toContain('fontsize=32');
  });

  it('escapes special characters in static text', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'static_text', enabled: true, text: "it's a:test" }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain("\\'");
    expect(filter).toContain('\\:');
  });

  it('generates now_playing drawtext filter', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'now_playing', enabled: true }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('textfile=/shared/current_audio.txt');
    expect(filter).toContain('reload=1');
  });

  it('generates scrolling_text drawtext filter', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'scrolling_text', enabled: true, text: 'Breaking News', speed: 200 }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain("text='Breaking News'");
    expect(filter).toContain('x=w-mod(t*200,w+text_w)');
    expect(filter).toContain('y=(h-text_h)/2');
  });

  it('uses default speed 100 for scrolling_text', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'scrolling_text', enabled: true, text: 'Test' }]
    });
    expect(files[FILTER_STRING_FILE]).toContain('t*100');
  });

  it('uses specified y instead of centered for scrolling_text', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'scrolling_text', enabled: true, text: 'Test', y: '50' }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('y=50');
    expect(filter).not.toContain('(h-text_h)/2');
  });

  it('generates scrolling_now_playing drawtext filter', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'scrolling_now_playing', enabled: true, speed: 150 }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('textfile=/shared/current_track_clean.txt');
    expect(filter).toContain('reload=1');
    expect(filter).toContain('t*150');
  });

  it('generates box background when boxcolor set', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'static_text', enabled: true, text: 'Test', boxcolor: 'black@0.5' }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('box=1');
    expect(filter).toContain('boxcolor=black@0.5');
    expect(filter).toContain('boxborderw=8');
  });

  it('ignores unknown layer types', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'unknown_type', enabled: true }]
    });
    // Only format=yuv420p should be present, no drawtext
    expect(files[FILTER_STRING_FILE]).toBe('format=yuv420p');
  });

  it('combines multiple text layers into comma-separated chain', () => {
    generateFilterString({
      enabled: true,
      layers: [
        { type: 'clock', enabled: true, fontsize: 24, x: '10', y: '10' },
        { type: 'static_text', enabled: true, text: 'LIVE', fontsize: 48, x: '10', y: '50' }
      ]
    });
    const filter = files[FILTER_STRING_FILE];
    // Should have two drawtext filters separated by comma
    const drawTextCount = (filter.match(/drawtext=/g) || []).length;
    expect(drawTextCount).toBe(2);
    expect(filter).toContain(',');
    expect(filter).toContain('format=yuv420p');
  });

  it('writes overlay_compiled.json with logo info', () => {
    generateFilterString({
      enabled: true,
      layers: [
        { type: 'logo', enabled: true, asset: 'logo.png', x: '20', y: '20', opacity: 0.8 },
        { type: 'clock', enabled: true }
      ]
    });
    expect(files[COMPILED_FILE]).toBeDefined();
    const compiled = JSON.parse(files[COMPILED_FILE]);
    expect(compiled.logoInputs.length).toBe(1);
    expect(compiled.logoInputs[0].opacity).toBe(0.8);
    expect(compiled.filterChain).toContain('drawtext=');
  });

  it('skips disabled layers in filter chain', () => {
    generateFilterString({
      enabled: true,
      layers: [
        { type: 'clock', enabled: false },
        { type: 'static_text', enabled: true, text: 'ON' }
      ]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).not.toContain('localtime');
    expect(filter).toContain("text='ON'");
  });

  // --- Added characterization: sanitization fallbacks + compiled-json quirks ---

  it('falls back to default fontsize/fontcolor/x/y when values fail the regex', () => {
    // fontsize must be ^\d{1,4}$, fontcolor ^[a-zA-Z0-9#@]{1,30}$, coords the
    // ^[\d()wh+-*/. ]{1,80}$ set. Out-of-range/illegal values fall back AS-IS.
    generateFilterString({
      enabled: true,
      layers: [{
        type: 'static_text', enabled: true, text: 'X',
        fontsize: 'huge',          // not digits -> '24'
        fontcolor: 'bad;color!',   // ';' and '!' illegal -> 'white'
        x: 'drop table;',          // illegal chars -> '10'
        y: '$(rm)',                // illegal chars -> '10'
      }]
    });
    const filter = files[FILTER_STRING_FILE];
    expect(filter).toContain('fontsize=24');
    expect(filter).toContain('fontcolor=white');
    expect(filter).toContain('x=10');
    expect(filter).toContain('y=10');
  });

  it('boxcolor falls back to black@0.5 when value is illegal', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'static_text', enabled: true, text: 'X', boxcolor: 'has space' }]
    });
    const filter = files[FILTER_STRING_FILE];
    // box=1 / boxborderw=8 are always added once boxcolor is truthy; the color
    // itself sanitizes back to the default.
    expect(filter).toContain('box=1');
    expect(filter).toContain('boxcolor=black@0.5');
    expect(filter).toContain('boxborderw=8');
  });

  it('clock format falls back to %H\\:%M when format fails the regex', () => {
    // RE_FORMAT forbids ';' — illegal format -> default '%H\:%M', then every ':'
    // is doubled-escaped by the trailing .replace(/:/g, '\\:').
    generateFilterString({
      enabled: true,
      layers: [{ type: 'clock', enabled: true, format: 'evil;%H' }]
    });
    // Default literal is '%H\:%M'; the trailing .replace(/:/g,'\\:') turns that
    // single ':' into '\:', producing '%H\\:%M' (two backslashes before the
    // colon). The 'localtime\:' separator is added literally by buildDrawtext.
    expect(files[FILTER_STRING_FILE]).toContain("text='%{localtime\\:%H\\\\:%M}'");
  });

  it('static_text with no text emits a bare drawtext (no text= key) AS-IS', () => {
    // buildDrawtext returns the filter as long as `common` is non-empty; with no
    // text and no styling, static_text contributes nothing, so common stays empty
    // -> buildDrawtext returns null and only format=yuv420p is written.
    generateFilterString({
      enabled: true,
      layers: [{ type: 'static_text', enabled: true }]
    });
    expect(files[FILTER_STRING_FILE]).toBe('format=yuv420p');
  });

  it('drops a logo layer with no asset from logoInputs (type logo + !asset)', () => {
    // logoLayers requires l.type==='logo' && l.asset. A logo without asset is in
    // neither logoLayers nor textLayers -> contributes nothing, logoInputs empty.
    generateFilterString({
      enabled: true,
      layers: [{ type: 'logo', enabled: true }]
    });
    expect(files[FILTER_STRING_FILE]).toBe('format=yuv420p');
    const compiled = JSON.parse(files[COMPILED_FILE]);
    expect(compiled.logoInputs).toEqual([]);
  });

  it('logo x/y sanitize and opacity defaults to 1.0 when falsy', () => {
    generateFilterString({
      enabled: true,
      layers: [{ type: 'logo', enabled: true, asset: 'l.png', x: 'BAD!', y: 'NOPE!', opacity: 0 }]
    });
    const compiled = JSON.parse(files[COMPILED_FILE]);
    expect(compiled.logoInputs[0].x).toBe('20'); // coord default for logos is '20'
    expect(compiled.logoInputs[0].y).toBe('20');
    expect(compiled.logoInputs[0].opacity).toBe(1.0); // 0 is falsy -> 1.0
    expect(compiled.logoInputs[0].asset).toBe(ASSETS_DIR + '/l.png');
  });

  it('does NOT write overlay_compiled.json when there are no enabled layers', () => {
    generateFilterString({ enabled: true, layers: [{ type: 'clock', enabled: false }] });
    expect(files[COMPILED_FILE]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createOverlayRouter — construction
// ---------------------------------------------------------------------------
describe('createOverlayRouter construction', () => {
  // Both the router's own guard and multer mkdir ASSETS_DIR while the router is
  // being constructed, so these pins have to separate the two. They do NOT do
  // that by the shape of the call: which fs API multer reaches for is multer's
  // private business and it changes between releases (2.0.2 went through mkdirp
  // with a positional mode, 2.2.0 calls fs.mkdirSync with { recursive: true }),
  // and a pin that reads that shape breaks on an upgrade while the code under
  // test is untouched.
  //
  // Instead: measure what multer alone does and subtract it.
  //
  // THE LOAD-BEARING ASSUMPTION is that multer's own mkdir count does not depend
  // on whether ASSETS_DIR already exists — and note the two arms do not observe
  // the same state. The harness's mkdirSync mock flips assetsDirExists to true,
  // so in routerMkdirs(false) the router creates the dir first and multer is
  // then constructed against an EXISTING dir, while multerOwnMkdirs(false)
  // constructs multer with the dir still MISSING. The subtraction is only valid
  // because that difference does not change multer's count. Probed on both
  // versions: multer alone mkdirs ASSETS_DIR exactly once either way (2.0.2 via
  // mkdirp, 2.2.0 via fs.mkdirSync), giving 2 vs 1 for the router.
  //
  // ACCEPTED TRADE: these pins now count calls instead of asserting the
  // { recursive: true } flag, so they no longer notice HOW the directory gets
  // created — a router switched to some other creation strategy would keep them
  // green. Pinning that flag is what coupled the old version to multer.

  /**
   * mkdirs of ASSETS_DIR caused by constructing multer the way the router does.
   * fileFilter is omitted deliberately: it runs per uploaded file at request
   * time and cannot affect directory creation, so leaving it out keeps the
   * baseline to the options that can.
   */
  function multerOwnMkdirs(assetsDirExists) {
    const local = installOverlayFsHarness({ assetsDirExists });
    multer({ dest: ASSETS_DIR, limits: { fileSize: 10 * 1024 * 1024 } });
    const count = local.mkdirCalls.filter(c => c.p === ASSETS_DIR).length;
    vi.restoreAllMocks();
    return count;
  }

  /** mkdirs of ASSETS_DIR caused by building the whole router. */
  function routerMkdirs(assetsDirExists) {
    const local = installOverlayFsHarness({ assetsDirExists });
    local.makeApp();
    const count = local.mkdirCalls.filter(c => c.p === ASSETS_DIR).length;
    vi.restoreAllMocks();
    return count;
  }

  it('creates ASSETS_DIR when missing — one mkdir beyond multer own', () => {
    expect(routerMkdirs(false)).toBe(multerOwnMkdirs(false) + 1);
  });

  it('does NOT create ASSETS_DIR when it already exists', () => {
    expect(routerMkdirs(true)).toBe(multerOwnMkdirs(true));
  });
});

// ---------------------------------------------------------------------------
// GET /api/overlays
// ---------------------------------------------------------------------------
describe('GET /api/overlays', () => {
  it('returns the default config when no file exists', async () => {
    const res = await client.get('/api/overlays');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, layers: [] });
  });

  it('returns the stored config when the file exists', async () => {
    const data = { enabled: true, layers: [{ type: 'clock', enabled: true }] };
    files[OVERLAY_CONFIG] = JSON.stringify(data);
    const res = await client.get('/api/overlays');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/overlays — tier gating + save
// ---------------------------------------------------------------------------
describe('PUT /api/overlays', () => {
  it('saves config and regenerates filter string on the free tier when only watermark layers (no custom)', async () => {
    // free tier: customOverlays=false. A watermark-only config is allowed.
    const body = { enabled: true, layers: [{ type: 'watermark', enabled: true }] };
    const res = await client
      .put('/api/overlays')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    // saveOverlays wrote OVERLAY_CONFIG and (via generateFilterString) the filter.
    expect(JSON.parse(files[OVERLAY_CONFIG])).toEqual(body);
    expect(FILTER_STRING_FILE in files).toBe(true);
  });

  it('returns 403 on free tier when enabled config has a non-watermark (custom) layer', async () => {
    // free tier customOverlays=false; hasCustomLayers && enabled -> 403.
    const body = { enabled: true, layers: [{ type: 'clock', enabled: true }] };
    const res = await client
      .put('/api/overlays')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Custom overlays not available in your tier' });
    // Nothing persisted.
    expect(OVERLAY_CONFIG in files).toBe(false);
  });

  it('allows a custom layer on free tier when config is DISABLED (enabled=false) AS-IS', async () => {
    // The guard requires hasCustomLayers && config.enabled. enabled=false slips
    // the custom layer through and saves it.
    const body = { enabled: false, layers: [{ type: 'clock', enabled: true }] };
    const res = await client
      .put('/api/overlays')
      .send(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(files[OVERLAY_CONFIG])).toEqual(body);
  });

  it('saves custom layers when tier file grants pro (customOverlays=true)', async () => {
    files['/shared/tier.json'] = JSON.stringify({ tier: 'pro' });
    const body = { enabled: true, layers: [{ type: 'clock', enabled: true }] };
    const res = await client
      .put('/api/overlays')
      .send(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(files[OVERLAY_CONFIG])).toEqual(body);
  });

  it('saves when layers is undefined (no custom-layer check trips)', async () => {
    // config.layers is falsy -> hasCustomLayers is falsy -> save proceeds.
    const body = { enabled: true };
    const res = await client
      .put('/api/overlays')
      .send(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(files[OVERLAY_CONFIG])).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// POST /api/overlays/assets — upload (REAL multer, fs spied for disk I/O)
// ---------------------------------------------------------------------------
describe('POST /api/overlays/assets', () => {
  it('returns 400 { error: "no file" } when no file attached', async () => {
    const res = await client.post('/api/overlays/assets');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no file' });
  });

  it('renames the upload to a sanitized name and returns name + dest path', async () => {
    // multer fileFilter allows png; '!' and space are non-[a-zA-Z0-9._-] -> '_'.
    const res = await client
      .post('/api/overlays/assets')
      .attach('file', Buffer.from('PNGDATA'), 'my logo!.png');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('my_logo_.png');
    expect(res.body.path).toBe(ASSETS_DIR + '/my_logo_.png');
    // The handler renamed the multer temp upload to the sanitized dest.
    expect(h.renamed.length).toBe(1);
    expect(h.renamed[0].to).toBe(ASSETS_DIR + '/my_logo_.png');
  });

  it('keeps allowed chars [a-zA-Z0-9._-] and replaces the rest with "_"', async () => {
    const res = await client
      .post('/api/overlays/assets')
      .attach('file', Buffer.from('x'), 'A1-b_c.D@#$.png');
    expect(res.status).toBe(200);
    // '@', '#', '$' -> '_'
    expect(res.body.name).toBe('A1-b_c.D___.png');
    expect(res.body.path).toBe(ASSETS_DIR + '/A1-b_c.D___.png');
  });

  it('rejects a name that sanitizes to start with "." and unlinks the temp file', async () => {
    // multer fileFilter only inspects the EXTENSION, so '.image.png' passes the
    // filter; basename keeps the leading dot -> safeName starts with '.' -> 400.
    const res = await client
      .post('/api/overlays/assets')
      .attach('file', Buffer.from('x'), '.image.png');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid filename' });
    // The multer temp file was unlinked before bailing.
    expect(h.unlinked.length).toBe(1);
    expect(h.renamed).toEqual([]);
  });

  it('a non-image extension is refused with a 400 and the filter message', async () => {
    // CHANGED IN T16-C2. fileFilter calls cb() with a 400-tagged Error for a
    // .txt. There used to be no error middleware anywhere, so Express's default
    // handler answered picking the wrong file with a 500 and an HTML stack.
    const res = await client
      .post('/api/overlays/assets')
      .attach('file', Buffer.from('x'), 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Only image files allowed' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/overlays/assets — list
// ---------------------------------------------------------------------------
describe('GET /api/overlays/assets', () => {
  it('lists non-dotfile assets with their sizes', async () => {
    h.setAssets({ 'a.png': 123, 'b.jpg': 456 });
    const res = await client.get('/api/overlays/assets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'a.png', size: 123 },
      { name: 'b.jpg', size: 456 },
    ]);
  });

  it('filters out dotfiles', async () => {
    h.setAssets({ '.hidden': 9, 'shown.png': 10 });
    const res = await client.get('/api/overlays/assets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'shown.png', size: 10 }]);
  });

  it('returns [] when readdir throws (swallowed catch)', async () => {
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('boom'); });
    const res = await client.get('/api/overlays/assets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/overlays/assets/:name
// ---------------------------------------------------------------------------
describe('DELETE /api/overlays/assets/:name', () => {
  it('unlinks an existing asset and returns { ok: true }', async () => {
    h.setAssets({ 'gone.png': 1 });
    const res = await client.delete('/api/overlays/assets/gone.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.unlinked).toContain(ASSETS_DIR + '/gone.png');
  });

  it('returns { ok: true } even when the file does not exist (no unlink)', async () => {
    const res = await client.delete('/api/overlays/assets/missing.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.unlinked).toEqual([]);
  });

  it('returns 400 invalid path when name resolves outside ASSETS_DIR via traversal', async () => {
    // path.join(ASSETS_DIR, '../../etc/passwd') escapes ASSETS_DIR entirely.
    // Express decodes %2e%2e to '..'.
    const res = await client.delete('/api/overlays/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid path' });
  });

  it('returns 400 for a sibling directory that merely starts with the assets path', async () => {
    // CHANGED IN T16-C2. The guard was a bare indexOf(ASSETS_DIR) !== 0, which
    // this target satisfies: '/shared/overlay_assets_backup/logo.png' does
    // start with '/shared/overlay_assets'. It was unlinked. The upload path
    // already anchored on path.sep; this one now does too.
    const res = await client.delete('/api/overlays/assets/%2e%2e%2foverlay_assets_backup%2flogo.png');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid path' });
    expect(h.unlinked).toEqual([]);
  });

  it('refuses a name that collapses back onto the assets directory itself', async () => {
    // 'x/..' rejoins to exactly ASSETS_DIR. The upload guard tolerates that
    // form (it has a filename to append afterwards); here there would be
    // nothing to unlink but the directory, so the separator is required.
    const res = await client.delete('/api/overlays/assets/x%2f%2e%2e');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid path' });
    expect(h.unlinked).toEqual([]);
  });
});

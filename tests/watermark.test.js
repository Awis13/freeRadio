import { describe, it, expect, vi, beforeEach } from 'vitest';

// Virtual file system
const virtualFs = {};

function resetVirtualFs(files = {}) {
  for (const key of Object.keys(virtualFs)) delete virtualFs[key];
  for (const [k, v] of Object.entries(files)) virtualFs[k] = v;
}

// Mock fs — CJS require('fs') gets the default export
vi.mock('fs', () => {
  const mock = {
    existsSync: (p) => p in virtualFs,
    readFileSync: (p) => {
      if (p in virtualFs) return virtualFs[p];
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync: (p, data) => { virtualFs[p] = data; },
    mkdirSync: () => {},
    readdirSync: () => [],
    statSync: () => ({ size: 0 }),
    renameSync: () => {},
    unlinkSync: () => {},
  };
  // CJS require('fs') uses module.exports directly
  return { ...mock, default: mock };
});

vi.mock('express', () => {
  const router = { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() };
  const express = () => ({ use: vi.fn() });
  express.Router = () => router;
  express.json = () => ((req, res, next) => next());
  express.static = () => ((req, res, next) => next());
  return { default: express };
});

vi.mock('multer', () => {
  return { default: () => ({ single: () => ((req, res, next) => next()) }) };
});

vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return { ...actual, default: actual };
});

describe('watermark — ensureWatermark()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('adds a watermark for the free tier', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'free' }),
      '/shared/overlays.json': JSON.stringify({ enabled: false, layers: [] }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    expect(saved.enabled).toBe(true);
    expect(saved.layers).toHaveLength(1);
    expect(saved.layers[0]).toMatchObject({
      type: 'watermark',
      system: true,
      text: 'STUDIO 23',
      enabled: true,
    });
  });

  it('removes the watermark for the pro tier', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'pro' }),
      '/shared/overlays.json': JSON.stringify({
        enabled: true,
        layers: [{ type: 'watermark', system: true, text: 'STUDIO 23', enabled: true }],
      }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    const watermarks = saved.layers.filter(l => l.type === 'watermark' && l.system);
    expect(watermarks).toHaveLength(0);
  });

  it('preserves user layers when adding the watermark', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'free' }),
      '/shared/overlays.json': JSON.stringify({
        enabled: true,
        layers: [
          { type: 'static_text', text: 'Hello', enabled: true },
          { type: 'watermark', system: true, text: 'OLD', enabled: true },
        ],
      }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    expect(saved.layers.filter(l => l.type === 'static_text')).toHaveLength(1);
    const wm = saved.layers.filter(l => l.type === 'watermark' && l.system);
    expect(wm).toHaveLength(1);
    expect(wm[0].text).toBe('STUDIO 23');
  });

  it('does not touch user watermark layers without the system flag', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'free' }),
      '/shared/overlays.json': JSON.stringify({
        enabled: true,
        layers: [
          { type: 'watermark', text: 'My Custom', enabled: true },
        ],
      }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    expect(saved.layers.filter(l => l.type === 'watermark' && !l.system)).toHaveLength(1);
    expect(saved.layers.filter(l => l.type === 'watermark' && l.system)).toHaveLength(1);
  });
});

describe('watermark — FFmpeg filter generation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('generates a valid drawtext filter for the watermark', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'free' }),
      '/shared/overlays.json': JSON.stringify({ enabled: false, layers: [] }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const filterStr = virtualFs['/shared/overlay_filter_string.txt'];
    expect(filterStr).toBeDefined();
    expect(filterStr).toContain('drawtext=');
    expect(filterStr).toContain('STUDIO 23');
    expect(filterStr).toContain('fontsize=28');
    expect(filterStr).toContain('fontcolor=white@0.6');
    expect(filterStr).toContain('format=yuv420p');
  });

  it('produces an empty filter string when there are no layers (pro tier)', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'pro' }),
      '/shared/overlays.json': JSON.stringify({ enabled: false, layers: [] }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const filterStr = virtualFs['/shared/overlay_filter_string.txt'];
    expect(filterStr).toBe('');
  });
});

describe('watermark — saveOverlays protection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('restores the watermark after ensureWatermark', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'free' }),
      '/shared/overlays.json': JSON.stringify({ enabled: true, layers: [] }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.saveOverlays({ enabled: true, layers: [] });
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    expect(saved.layers.some(l => l.type === 'watermark' && l.system)).toBe(true);
  });

  it('does not add a watermark for the pro tier', async () => {
    resetVirtualFs({
      '/shared/tier.json': JSON.stringify({ tier: 'pro' }),
      '/shared/overlays.json': JSON.stringify({ enabled: true, layers: [] }),
    });

    const overlay = await import('../dashboard/lib/overlay.js');
    overlay.ensureWatermark();

    const saved = JSON.parse(virtualFs['/shared/overlays.json']);
    expect(saved.layers.filter(l => l.type === 'watermark' && l.system)).toHaveLength(0);
  });
});

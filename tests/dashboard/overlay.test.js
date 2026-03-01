/**
 * tests/dashboard/overlay.test.js
 *
 * Unit tests for dashboard/lib/overlay.js — overlay filter generation.
 * Tests: loadOverlays, generateFilterString.
 * buildDrawtext is tested indirectly through generateFilterString.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const OVERLAY_CONFIG = '/shared/overlays.json';
const FILTER_STRING_FILE = '/shared/overlay_filter_string.txt';
const COMPILED_FILE = '/shared/overlay_compiled.json';

let files = {};

vi.mock('express', () => ({
  default: { Router: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() })) },
  Router: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }))
}));
vi.mock('multer', () => ({ default: vi.fn(() => ({ single: vi.fn() })) }));

beforeEach(() => {
  files = {};
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
});

const { loadOverlays, generateFilterString } =
  await import('../../dashboard/lib/overlay.js');

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
});

/**
 * tests/dashboard/metrics.test.js
 *
 * Unit tests for dashboard/lib/metrics.js — MetricsExporter class.
 * Tests metric storage/update and Prometheus text format generation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import http from 'http';

beforeEach(() => {
  vi.restoreAllMocks();

  // Mock os.totalmem/freemem for deterministic system metrics
  vi.spyOn(os, 'totalmem').mockReturnValue(16000000000);
  vi.spyOn(os, 'freemem').mockReturnValue(8000000000);
});

const { MetricsExporter } =
  await import('../../dashboard/lib/metrics.js');

// ---------------------------------------------------------------------------
// MetricsExporter — update()
// ---------------------------------------------------------------------------
describe('MetricsExporter update()', () => {
  it('initializes all metrics to zero', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_connected 0');
    expect(output).toContain('s23_ffmpeg_bitrate 0');
    expect(output).toContain('s23_ffmpeg_fps 0');
    expect(output).toContain('s23_youtube_connected 0');
    expect(output).toContain('s23_kick_connected 0');
    expect(output).toContain('s23_track_bpm 0');
    expect(output).toContain('s23_analyzed_tracks 0');
  });

  it('updates a single metric', () => {
    const m = new MetricsExporter();
    m.update('ffmpeg_fps', 30);
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_fps 30');
  });

  it('updates multiple metrics independently', () => {
    const m = new MetricsExporter();
    m.update('ffmpeg_connected', 1);
    m.update('ffmpeg_bitrate', 8500);
    m.update('current_track_bpm', 145);
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_connected 1');
    expect(output).toContain('s23_ffmpeg_bitrate 8500');
    expect(output).toContain('s23_track_bpm 145');
  });

  it('overwrites previous value on repeated update', () => {
    const m = new MetricsExporter();
    m.update('ffmpeg_fps', 25);
    m.update('ffmpeg_fps', 30);
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_fps 30');
    expect(output).not.toMatch(/s23_ffmpeg_fps 25/);
  });

  it('accepts zero as a valid value', () => {
    const m = new MetricsExporter();
    m.update('ffmpeg_connected', 1);
    m.update('ffmpeg_connected', 0);
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_connected 0');
  });

  it('accepts decimal values', () => {
    const m = new MetricsExporter();
    m.update('ffmpeg_fps', 29.97);
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_ffmpeg_fps 29.97');
  });
});

// ---------------------------------------------------------------------------
// MetricsExporter — getPrometheusFormat()
// ---------------------------------------------------------------------------
describe('MetricsExporter getPrometheusFormat()', () => {
  it('includes HELP lines for all metrics', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    expect(output).toContain('# HELP s23_ffmpeg_connected');
    expect(output).toContain('# HELP s23_ffmpeg_bitrate');
    expect(output).toContain('# HELP s23_ffmpeg_fps');
    expect(output).toContain('# HELP s23_youtube_connected');
    expect(output).toContain('# HELP s23_kick_connected');
    expect(output).toContain('# HELP s23_track_bpm');
    expect(output).toContain('# HELP s23_analyzed_tracks');
    expect(output).toContain('# HELP s23_memory_usage_bytes');
    expect(output).toContain('# HELP s23_memory_total_bytes');
  });

  it('includes TYPE lines for all metrics', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    expect(output).toContain('# TYPE s23_ffmpeg_connected gauge');
    expect(output).toContain('# TYPE s23_ffmpeg_bitrate gauge');
    expect(output).toContain('# TYPE s23_ffmpeg_fps gauge');
    expect(output).toContain('# TYPE s23_youtube_connected gauge');
    expect(output).toContain('# TYPE s23_kick_connected gauge');
    expect(output).toContain('# TYPE s23_track_bpm gauge');
    expect(output).toContain('# TYPE s23_analyzed_tracks gauge');
    expect(output).toContain('# TYPE s23_memory_usage_bytes gauge');
    expect(output).toContain('# TYPE s23_memory_total_bytes gauge');
  });

  it('ends with newline', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    expect(output.endsWith('\n')).toBe(true);
  });

  it('uses s23_ prefix for all metric names', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    const metricLines = output.split('\n').filter(l => l && !l.startsWith('#'));
    for (const line of metricLines) {
      expect(line).toMatch(/^s23_/);
    }
  });

  it('includes system memory metrics from os module', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    // usedMem = totalMem - freeMem = 16000000000 - 8000000000 = 8000000000
    expect(output).toContain('s23_memory_usage_bytes 8000000000');
    expect(output).toContain('s23_memory_total_bytes 16000000000');
  });

  it('reflects updated memory values', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(32000000000);
    vi.spyOn(os, 'freemem').mockReturnValue(16000000000);
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    expect(output).toContain('s23_memory_usage_bytes 16000000000');
    expect(output).toContain('s23_memory_total_bytes 32000000000');
  });

  it('each metric has HELP, TYPE, and value in correct order', () => {
    const m = new MetricsExporter();
    const output = m.getPrometheusFormat();
    const lines = output.split('\n');

    // Find ffmpeg_connected block
    const helpIdx = lines.findIndex(l => l.includes('HELP s23_ffmpeg_connected'));
    expect(helpIdx).toBeGreaterThanOrEqual(0);
    expect(lines[helpIdx + 1]).toContain('TYPE s23_ffmpeg_connected');
    expect(lines[helpIdx + 2]).toMatch(/^s23_ffmpeg_connected /);
  });
});

// ---------------------------------------------------------------------------
// MetricsExporter — separate instances
// ---------------------------------------------------------------------------
describe('MetricsExporter isolation', () => {
  it('separate instances have independent state', () => {
    const m1 = new MetricsExporter();
    const m2 = new MetricsExporter();

    m1.update('ffmpeg_fps', 60);
    m2.update('ffmpeg_fps', 24);

    expect(m1.getPrometheusFormat()).toContain('s23_ffmpeg_fps 60');
    expect(m2.getPrometheusFormat()).toContain('s23_ffmpeg_fps 24');
  });
});

// ---------------------------------------------------------------------------
// MetricsExporter — start()  (real http server on the hardcoded METRICS_PORT)
// ---------------------------------------------------------------------------
const METRICS_PORT = 9091; // pinned as-is: start() hardcodes this port

// Loopback GET against the exporter's fixed port; resolves with status + body.
function fetchMetrics(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent:false -> a fresh socket per request, so a pooled keep-alive
      // socket from a prior (now-closed) server can't be reused.
      { host: '127.0.0.1', port: METRICS_PORT, path, method: 'GET', agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          body,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Grab the http.Server that start() created so the test can close it,
// and wait until it is actually bound + the listen callback has run.
function startAndCapture(exporter) {
  let captured = null;
  const origCreate = http.createServer;
  const spy = vi.spyOn(http, 'createServer').mockImplementation((handler) => {
    captured = origCreate(handler);
    return captured;
  });
  exporter.start();
  spy.mockRestore();
  // Always wait for the 'listening' event. start() registers the log callback
  // as a 'listening' listener first, so by the time ours fires the log is done.
  return new Promise((resolve, reject) => {
    captured.once('error', reject);
    captured.once('listening', () => resolve(captured));
  });
}

describe('MetricsExporter start()', () => {
  it('listens on the metrics port and logs a startup line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new MetricsExporter();
    const server = await startAndCapture(m);
    try {
      // pinned as-is: start() logs this exact line in the listen callback
      expect(logSpy).toHaveBeenCalledWith(
        `[metrics] Prometheus exporter on port ${METRICS_PORT}`,
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('serves Prometheus text on GET /metrics with 200 + text/plain', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new MetricsExporter();
    m.update('ffmpeg_fps', 30);
    const server = await startAndCapture(m);
    try {
      const res = await fetchMetrics('/metrics');
      expect(res.status).toBe(200);
      // pinned as-is: Content-Type is set to 'text/plain' (no charset/version)
      expect(res.contentType).toBe('text/plain');
      // body is exactly getPrometheusFormat() output for current state
      expect(res.body).toBe(m.getPrometheusFormat());
      expect(res.body).toContain('s23_ffmpeg_fps 30');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('returns 404 "Not found" for any non-/metrics path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new MetricsExporter();
    const server = await startAndCapture(m);
    try {
      const res = await fetchMetrics('/health');
      expect(res.status).toBe(404);
      // pinned as-is: 404 path writes no Content-Type header, body is 'Not found'
      expect(res.body).toBe('Not found');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('treats exact path only: "/metrics?x=1" with query is NOT the metrics route', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = new MetricsExporter();
    const server = await startAndCapture(m);
    try {
      // pinned as-is: route check is `req.url === '/metrics'` (strict ===),
      // so any query string makes req.url !== '/metrics' -> 404 branch
      const res = await fetchMetrics('/metrics?x=1');
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not found');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

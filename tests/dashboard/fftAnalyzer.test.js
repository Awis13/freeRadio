/**
 * tests/dashboard/fftAnalyzer.test.js
 *
 * Characterization of dashboard/lib/fftAnalyzer.js (P1-6).
 *
 * Strategy: fftAnalyzer destructures spawn from child_process at require
 * time, so we PRE-SEED require.cache with a fake child_process exposing a
 * controllable spawn BEFORE requiring the module (vi.mock is inert for
 * CJS-internal requires here). The fake process is an EventEmitter with
 * stdout/stderr EventEmitters; we drive PCM by emitting Buffers on
 * proc.stdout and observe binary frames via a fake ws {readyState:1,
 * send: vi.fn()}.
 *
 * PCM layout: interleaved s16le stereo, so each sample frame is 4 bytes
 * (L int16, R int16). One hop = HOP_SIZE(512) sample-frames = 2048 bytes.
 *
 * Pinned here (current behavior):
 *   - frame contract: 2049 bytes, buf[0] === 0x01, then 1024 spectrum +
 *     512 waveL + 512 waveR;
 *   - _addHop accounting: 4 hops of 512 samples fill the 2048 window before
 *     the FIRST frame; thereafter 50% overlap -> one frame per subsequent
 *     hop;
 *   - no-subscriber fast path: winFilled is reset to 0 and no frame is sent;
 *   - silence input -> spectrum clamps to 0 across all bins;
 *   - a moderate DC (constant) signal puts bin 0 as the STRICT unique maximum
 *     (amplitude is chosen so bin 0 does not saturate and no other bin ties it);
 *   - the full spectrum pipeline matches an INDEPENDENT naive O(N^2) DFT
 *     reference computed inline (mono mix * Hanning -> DFT -> magnitude/N ->
 *     dB -> byte), pinning fft()'s math byte-for-byte through the frame seam;
 *   - waveL/waveR bytes are signed->unsigned (& 0xFF): a negative sample
 *     maps to 128..255.
 *
 * fft(re, im, N) is module-private (only { FftAnalyzer } is exported), so it
 * cannot be unit-tested directly without a production change. We therefore
 * pin its math through the sole available seam — the binary frame — by
 * feeding a known constant input and comparing the emitted spectrum bytes
 * against an independent DFT computed with the naive summation formula.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const nodeRequire = createRequire(import.meta.url);
const FFT_SPEC = '../../dashboard/lib/fftAnalyzer';
const CP_SPEC = 'child_process';

const FFT_SIZE = 2048;
const HOP_SIZE = 512;
const HOP_BYTES = HOP_SIZE * 2 * 2; // 2048 bytes per hop
const FRAME_SIZE = 2049;
const BIN_COUNT = 1024;

let spawnArgs;
let fakeProc;
let realCp;
let FftAnalyzer;

/** Build a fake child process: EventEmitter with stdout/stderr emitters + kill. */
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

/** Seed require.cache with a fake child_process, then fresh-require fftAnalyzer. */
function seedAndRequire() {
  const cpId = nodeRequire.resolve(CP_SPEC);
  realCp = nodeRequire.cache[cpId];
  const fakeSpawn = vi.fn((cmd, args) => {
    spawnArgs = { cmd, args };
    fakeProc = makeFakeProc();
    return fakeProc;
  });
  nodeRequire.cache[cpId] = {
    id: cpId, filename: cpId, loaded: true, exports: { spawn: fakeSpawn }
  };
  delete nodeRequire.cache[nodeRequire.resolve(FFT_SPEC)];
  ({ FftAnalyzer } = nodeRequire(FFT_SPEC));
}

/** Build one hop (2048 bytes) of interleaved s16le stereo with a constant value. */
function hopConst(value) {
  const buf = Buffer.alloc(HOP_BYTES);
  for (let i = 0; i < HOP_SIZE; i++) {
    buf.writeInt16LE(value, i * 4);
    buf.writeInt16LE(value, i * 4 + 2);
  }
  return buf;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedAndRequire();
});

afterEach(() => {
  // Restore the real child_process and drop the seeded fftAnalyzer.
  const cpId = nodeRequire.resolve(CP_SPEC);
  if (realCp) nodeRequire.cache[cpId] = realCp;
  else delete nodeRequire.cache[cpId];
  delete nodeRequire.cache[nodeRequire.resolve(FFT_SPEC)];
  vi.restoreAllMocks();
});

describe('dashboard/lib/fftAnalyzer.js spawn lifecycle', () => {
  it('start() spawns ffmpeg once; stop() kills with SIGKILL', () => {
    const a = new FftAnalyzer();
    a.start();
    expect(spawnArgs.cmd).toBe('ffmpeg');
    a.start(); // idempotent: already running
    a.stop();
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('dashboard/lib/fftAnalyzer.js frame contract + hop accounting', () => {
  it('emits the first 2049-byte frame only after 4 hops fill the window', () => {
    const a = new FftAnalyzer();
    a.start();
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);

    // 3 hops: window not yet full (3*512 = 1536 < 2048) -> no frame.
    for (let i = 0; i < 3; i++) fakeProc.stdout.emit('data', hopConst(8000));
    expect(ws.send).not.toHaveBeenCalled();

    // 4th hop: window filled (2048) -> exactly one frame.
    fakeProc.stdout.emit('data', hopConst(8000));
    expect(ws.send).toHaveBeenCalledTimes(1);

    const frame = ws.send.mock.calls[0][0];
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(frame.length).toBe(FRAME_SIZE);
    expect(frame[0]).toBe(0x01);

    // 5th hop: 50% overlap -> one more frame per hop.
    fakeProc.stdout.emit('data', hopConst(8000));
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('a single stdout chunk spanning multiple hops is split into hops', () => {
    const a = new FftAnalyzer();
    a.start();
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);
    // 5 hops in one chunk: 4 to fill + 1 overlap = 2 frames.
    const big = Buffer.concat([
      hopConst(6000), hopConst(6000), hopConst(6000), hopConst(6000), hopConst(6000)
    ]);
    fakeProc.stdout.emit('data', big);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });
});

describe('dashboard/lib/fftAnalyzer.js no-subscriber fast path', () => {
  it('with no subscribers: no frame, and winFilled stays reset (does not accumulate)', () => {
    const a = new FftAnalyzer();
    a.start();
    // Feed many hops with NO subscriber.
    for (let i = 0; i < 10; i++) fakeProc.stdout.emit('data', hopConst(8000));
    expect(a.winFilled).toBe(0); // reset every hop

    // Subscribe now; it still takes a fresh 4 hops to produce the first frame.
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);
    for (let i = 0; i < 3; i++) fakeProc.stdout.emit('data', hopConst(8000));
    expect(ws.send).not.toHaveBeenCalled();
    fakeProc.stdout.emit('data', hopConst(8000));
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard/lib/fftAnalyzer.js spectrum (DFT correctness)', () => {
  function firstFrame(value) {
    const a = new FftAnalyzer();
    a.start();
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);
    for (let i = 0; i < 4; i++) fakeProc.stdout.emit('data', hopConst(value));
    return ws.send.mock.calls[0][0];
  }

  it('silence -> spectrum clamps to 0 across all bins', () => {
    const frame = firstFrame(0);
    const spectrum = frame.subarray(1, 1 + BIN_COUNT);
    expect([...spectrum].every((b) => b === 0)).toBe(true);
  });

  it('moderate DC -> bin 0 is the STRICT unique maximum (no saturation/tie)', () => {
    // Amplitude 300 is chosen so bin 0 does NOT saturate: with the source math
    // (mono mix * Hann -> fft -> mag/1024 -> dB -> byte) it lands at 216, a
    // strict max over every other bin (bin 1 = 194, the rest 0). Contrast with
    // 30000, which drives BOTH bin 0 and bin 1 to 255, so a max-index check
    // would only pass by first-index tie-break. Here we assert STRICT '>'.
    const frame = firstFrame(300);
    const spectrum = frame.subarray(1, 1 + BIN_COUNT);
    expect(spectrum[0]).toBe(216);
    expect(spectrum[0]).toBeLessThan(255); // not saturated -> a real maximum
    for (let i = 1; i < BIN_COUNT; i++) {
      expect(spectrum[i]).toBeLessThan(spectrum[0]); // strict, unique max
    }
  });

  it('spectrum matches an independent naive O(N^2) DFT byte-for-byte', () => {
    // Independent math pin for fft(). fft() is module-private, so we verify it
    // through the frame seam: feed a known constant input and recompute the
    // expected spectrum here with the naive DFT formula
    // X[k] = sum_n x[n] * exp(-2*pi*i*k*n/N), then apply the same
    // magnitude/dB/byte mapping the source uses. If fft()'s math drifts, the
    // emitted bytes diverge from this reference.
    const VALUE = 300;

    // Source parameters (mirrored locally; do not import from production).
    const N = FFT_SIZE;
    const MIN_DB = -100;
    const MAX_DB = -30;
    const DB_RANGE = MAX_DB - MIN_DB;

    // Hanning window, identical to the source definition.
    const hann = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    }

    // Input the module sees for a constant hop: winL[i] === winR[i] === s,
    // mono mix = (winL + winR) * 0.5 = s, then windowed.
    const s = VALUE / 32768;
    const x = new Float64Array(N);
    for (let n = 0; n < N; n++) x[n] = (s + s) * 0.5 * hann[n];

    // Independent naive DFT -> same magnitude/dB/byte mapping as the source.
    const expected = new Uint8Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        const ang = (-2 * Math.PI * k * n) / N;
        re += x[n] * Math.cos(ang);
        im += x[n] * Math.sin(ang);
      }
      const mag = Math.sqrt(re * re + im * im) / BIN_COUNT;
      const db = 20 * Math.log10(Math.max(mag, 1e-10));
      const val = (255 * (db - MIN_DB)) / DB_RANGE;
      expected[k] = Math.max(0, Math.min(255, Math.round(val)));
    }

    const frame = firstFrame(VALUE);
    const spectrum = frame.subarray(1, 1 + BIN_COUNT);
    expect([...spectrum]).toEqual([...expected]);
  });
});

describe('dashboard/lib/fftAnalyzer.js waveform byte mapping', () => {
  it('negative samples map to the upper half (signed -> unsigned & 0xFF)', () => {
    const a = new FftAnalyzer();
    a.start();
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);
    // Constant strong-negative sample -> clamps to -128 -> & 0xFF = 128.
    for (let i = 0; i < 4; i++) fakeProc.stdout.emit('data', hopConst(-30000));
    const frame = ws.send.mock.calls[0][0];
    const waveL = frame.subarray(1 + BIN_COUNT, 1 + BIN_COUNT + 512);
    const waveR = frame.subarray(1 + BIN_COUNT + 512, FRAME_SIZE);
    // -30000/32768*127 rounds below -128 -> clamp -128 -> &0xFF = 128.
    expect([...waveL].every((b) => b >= 128)).toBe(true);
    expect([...waveR].every((b) => b >= 128)).toBe(true);
  });

  it('positive samples stay in the lower half (0..127)', () => {
    const a = new FftAnalyzer();
    a.start();
    const ws = { readyState: 1, send: vi.fn() };
    a.subscribe(ws);
    for (let i = 0; i < 4; i++) fakeProc.stdout.emit('data', hopConst(30000));
    const frame = ws.send.mock.calls[0][0];
    const waveL = frame.subarray(1 + BIN_COUNT, 1 + BIN_COUNT + 512);
    expect([...waveL].every((b) => b <= 127)).toBe(true);
  });
});

describe('dashboard/lib/fftAnalyzer.js subscriber readyState filter', () => {
  it('does not send to a ws whose readyState !== 1', () => {
    const a = new FftAnalyzer();
    a.start();
    const closed = { readyState: 3, send: vi.fn() };
    a.subscribe(closed);
    for (let i = 0; i < 5; i++) fakeProc.stdout.emit('data', hopConst(8000));
    expect(closed.send).not.toHaveBeenCalled();
  });
});

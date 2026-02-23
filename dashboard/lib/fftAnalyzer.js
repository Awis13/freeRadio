"use strict";
const { spawn } = require("child_process");

// --- Параметры, совпадающие с клиентским AnalyserNode ---
const FFT_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2; // 1024
const SAMPLE_RATE = 48000;
const HOP_SIZE = 512;           // 75% overlap → ~94fps
const MIN_DB = -100;
const MAX_DB = -30;
const DB_RANGE = MAX_DB - MIN_DB;
const WAVE_SIZE = 512;
const SMOOTHING = 0;  // Chrome AnalyserNode(0.82@375Hz) пересчитанный на ~63fps

// Hanning window
const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
}

// --- Radix-2 FFT (in-place, iterative) ---
function fft(re, im, N) {
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
    let k = N >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wR = Math.cos(angle);
    const wI = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < half; k++) {
        const u = i + k;
        const v = u + half;
        const tR = curR * re[v] - curI * im[v];
        const tI = curR * im[v] + curI * re[v];
        re[v] = re[u] - tR;
        im[v] = im[u] - tI;
        re[u] += tR;
        im[u] += tI;
        const newR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = newR;
      }
    }
  }
}

// Бинарный фрейм: [0x01][1024 spectrum][512 waveL][512 waveR] = 2049 bytes
const FRAME_SIZE = 1 + BIN_COUNT + WAVE_SIZE + WAVE_SIZE;

class FftAnalyzer {
  constructor() {
    this.proc = null;
    this.running = false;
    this.subscribers = new Set();
    // Sliding window для перекрывающихся FFT
    this.winL = new Float32Array(FFT_SIZE);
    this.winR = new Float32Array(FFT_SIZE);
    this.winFilled = 0;
    this.prevSpectrum = new Float64Array(1024);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._spawn();
  }

  stop() {
    this.running = false;
    if (this.proc) { this.proc.kill("SIGKILL"); this.proc = null; }
  }

  subscribe(ws) {
    this.subscribers.add(ws);
    console.log("[fft] +subscriber, total=" + this.subscribers.size);
  }

  unsubscribe(ws) {
    this.subscribers.delete(ws);
    console.log("[fft] -subscriber, total=" + this.subscribers.size);
  }

  _spawn() {
    this.winFilled = 0;
    this.prevSpectrum.fill(0);
    console.log("[fft] spawning ffmpeg (hop=" + HOP_SIZE + ", ~" + Math.round(SAMPLE_RATE / HOP_SIZE) + "fps)");

    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-reconnect", "1", "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", "http://icecast:8000/live",
      "-f", "s16le", "-acodec", "pcm_s16le",
      "-ar", String(SAMPLE_RATE), "-ac", "2",
      "pipe:1"
    ]);

    let pcmBuf = Buffer.alloc(0);
    const hopBytes = HOP_SIZE * 2 * 2; // samples × 2 bytes × 2 channels

    this.proc.stdout.on("data", (chunk) => {
      pcmBuf = Buffer.concat([pcmBuf, chunk]);
      while (pcmBuf.length >= hopBytes) {
        this._addHop(pcmBuf.subarray(0, hopBytes));
        pcmBuf = pcmBuf.subarray(hopBytes);
      }
    });

    this.proc.stderr.on("data", (d) => {
      console.error("[fft] ffmpeg:", d.toString().trim());
    });

    this.proc.on("close", (code) => {
      console.log("[fft] ffmpeg exited, code=" + code);
      this.proc = null;
      if (this.running) {
        setTimeout(() => { if (this.running) this._spawn(); }, 3000);
      }
    });

    this.proc.on("error", (err) => {
      console.error("[fft] spawn error:", err.message);
    });
  }

  _addHop(pcm) {
    if (this.subscribers.size === 0) {
      // Всё равно двигаем окно чтобы не рассинхронизироваться
      this.winFilled = 0;
      return;
    }

    if (this.winFilled >= FFT_SIZE) {
      // Сдвинуть окно влево на HOP_SIZE (50% overlap)
      this.winL.copyWithin(0, HOP_SIZE);
      this.winR.copyWithin(0, HOP_SIZE);
    }

    // Записать новые семплы в конец окна
    const writeStart = this.winFilled >= FFT_SIZE ? FFT_SIZE - HOP_SIZE : this.winFilled;
    for (let i = 0; i < HOP_SIZE; i++) {
      this.winL[writeStart + i] = pcm.readInt16LE(i * 4) / 32768;
      this.winR[writeStart + i] = pcm.readInt16LE(i * 4 + 2) / 32768;
    }

    this.winFilled = Math.min(this.winFilled + HOP_SIZE, FFT_SIZE);
    if (this.winFilled < FFT_SIZE) return; // ещё не набрали полное окно

    this._processWindow();
  }

  _processWindow() {
    // Mono mix + Hanning window → FFT
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (this.winL[i] + this.winR[i]) * 0.5 * hannWindow[i];
    }

    fft(re, im, FFT_SIZE);

    // Magnitude → dB → byte (0-255) + smoothing (как Chrome AnalyserNode)
    const spectrum = new Uint8Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / BIN_COUNT;
      const db = 20 * Math.log10(Math.max(mag, 1e-10));
      let val = 255 * (db - MIN_DB) / DB_RANGE;
      val = SMOOTHING * this.prevSpectrum[i] + (1 - SMOOTHING) * val;
      this.prevSpectrum[i] = val;
      spectrum[i] = Math.max(0, Math.min(255, Math.round(val)));
    }

    // Time domain L/R — последние WAVE_SIZE семплов из окна
    const waveL = Buffer.alloc(WAVE_SIZE);
    const waveR = Buffer.alloc(WAVE_SIZE);
    const offset = FFT_SIZE - WAVE_SIZE;
    for (let i = 0; i < WAVE_SIZE; i++) {
      waveL[i] = Math.max(-128, Math.min(127, Math.round(this.winL[offset + i] * 127))) & 0xFF;
      waveR[i] = Math.max(-128, Math.min(127, Math.round(this.winR[offset + i] * 127))) & 0xFF;
    }

    // Бинарный фрейм → подписчикам
    const buf = Buffer.alloc(FRAME_SIZE);
    buf[0] = 0x01;
    buf.set(spectrum, 1);
    buf.set(waveL, 1 + BIN_COUNT);
    buf.set(waveR, 1 + BIN_COUNT + WAVE_SIZE);

    for (const ws of this.subscribers) {
      try { if (ws.readyState === 1) ws.send(buf); } catch (e) {}
    }
  }
}

module.exports = { FftAnalyzer };

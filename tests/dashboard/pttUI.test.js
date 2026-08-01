/**
 * tests/dashboard/pttUI.test.js
 *
 * Characterization pins for the push-to-talk (PTT) UI cluster, currently living
 * inside the app.js IIFE (DOM refs app.js:60-76, vars app.js:2240-2253 + 2523,
 * functions + bindings app.js:2255-2573). These tests pin the AS-IS observable
 * contract of the deterministic, jsdom-runnable PTT logic before the C2
 * extraction into dashboard/public/ptt.js (window.FRPtt).
 *
 * They are authored in C1 against window.__appPtt (a test-only hook in the
 * bottom __APP_TEST__ guard of app.js) and will be re-pointed in C2 to
 * window.FRPtt with assertions UNCHANGED, proving behavioural equivalence.
 *
 * NOT pinned (cannot run in jsdom — getUserMedia/MediaRecorder/AudioContext/Audio):
 *   pttStartRecording, pttStopRecording, pttDown, pttUp, pttDrawWaveform,
 *   pttDrawStaticWaveform, pttPlayBtn.onclick. The harness getUserMedia never
 *   resolves and there is no MediaRecorder stub, so live capture is out of scope.
 *
 * Pinned (deterministic):
 *   - pttSetStatus FSM (className / label / timer display transitions)
 *   - pttReset (returns to idle, clears waveform)
 *   - pttSend fetch payload (FormData -> POST /api/voice/send) + landing FSM
 *   - pttLoadConfig config math (GET /api/voice/config -> slider values + text)
 *   - pttSaveConfig fetch payload (POST /api/voice/config JSON {duck,gain})
 *   - settings toggle button (#ptt-settings-btn) show/hide + active class + load
 *   - slider oninput immediate text (#ptt-duck-slider / #ptt-gain-slider)
 *   - discard/send buttons (#ptt-discard-btn / #ptt-send-btn)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot a fresh window and grab the PTT hook. No init/deps to inject — the hook
 *  fns are the real closure fns using the real deps (authFetch -> win.fetch). */
function boot() {
  const { win, doc } = bootWindow();
  const ptt = win.FRPtt;
  return { win, doc, ptt };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('push-to-talk UI characterization (window.FRPtt)', () => {
  it('exposes the cluster fns + state accessors', () => {
    const { ptt } = boot();
    expect(ptt).toBeTruthy();
    for (const fn of [
      'pttSetStatus', 'pttReset', 'pttClearWaveform', 'pttDrawWaveform',
      'pttDrawStaticWaveform', 'pttStartRecording', 'pttStopRecording',
      'pttSend', 'pttDown', 'pttUp', 'pttLoadConfig', 'pttSaveConfig',
      'getStatus', 'setStatus', 'getBlob', 'setBlob',
      'getBlobUrl', 'setBlobUrl', 'getIsHold', 'setIsHold',
    ]) {
      expect(typeof ptt[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // pttSetStatus — the status FSM (className / label / timer display)
  // -------------------------------------------------------------------------
  describe('pttSetStatus FSM', () => {
    it('idle -> ptt-bar / "Push to Talk" / timer hidden', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('idle');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar');
      expect(doc.getElementById('ptt-label').textContent).toBe('Push to Talk');
      expect(doc.getElementById('ptt-timer').style.display).toBe('none');
      expect(ptt.getStatus()).toBe('idle');
    });

    it('recording -> "ptt-bar recording" / "REC" / timer inline', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('recording');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar recording');
      expect(doc.getElementById('ptt-label').textContent).toBe('REC');
      expect(doc.getElementById('ptt-timer').style.display).toBe('inline');
    });

    it('preview -> "ptt-bar preview" / "Preview" / timer inline', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('preview');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar preview');
      expect(doc.getElementById('ptt-label').textContent).toBe('Preview');
      expect(doc.getElementById('ptt-timer').style.display).toBe('inline');
    });

    it('sending -> "ptt-bar sending" / "Sending..."', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('sending');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar sending');
      expect(doc.getElementById('ptt-label').textContent).toBe('Sending...');
    });

    it('sent -> "ptt-bar sent" / "Sent" (immediate state, before the 2s reset)', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('sent');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar sent');
      expect(doc.getElementById('ptt-label').textContent).toBe('Sent');
      expect(ptt.getStatus()).toBe('sent');
    });
  });

  // -------------------------------------------------------------------------
  // pttReset — back to idle + clears waveform
  // -------------------------------------------------------------------------
  describe('pttReset', () => {
    it('from preview returns to the idle visual state', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('preview');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar preview');
      ptt.pttReset();
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar');
      expect(doc.getElementById('ptt-label').textContent).toBe('Push to Talk');
      expect(doc.getElementById('ptt-timer').style.display).toBe('none');
      expect(ptt.getStatus()).toBe('idle');
    });
  });

  // -------------------------------------------------------------------------
  // pttSend — FormData upload + landing FSM
  // -------------------------------------------------------------------------
  describe('pttSend', () => {
    it('early-returns with no blob (no fetch, status unchanged)', async () => {
      const { win, ptt } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/voice/send', { ok: true, filename: 'x.webm' })]);
      ptt.setStatus('preview');
      ptt.pttSend();
      await flush();
      expect(stub.calls.length).toBe(0);
      expect(ptt.getStatus()).toBe('preview');
    });

    it('ok:true -> POST /api/voice/send raw FormData body, lands on "sent"', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/voice/send', { ok: true, filename: 'air-123.webm' })]);
      ptt.setBlob(new win.Blob(['audio-bytes'], { type: 'audio/webm' }));
      ptt.pttSend();
      // synchronous: immediately flips to 'sending'
      expect(ptt.getStatus()).toBe('sending');
      expect(doc.getElementById('ptt-label').textContent).toBe('Sending...');
      await flush();

      const send = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/voice/send');
      expect(send).toBeTruthy();
      // multipart FormData is kept raw by the stub (not JSON-parsed)
      expect(typeof send.body.append).toBe('function');
      expect(send.body.get('audio')).toBeTruthy();
      expect(ptt.getStatus()).toBe('sent');
      expect(doc.getElementById('ptt-label').textContent).toBe('Sent');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar sent');
    });

    it('ok:false -> showError banner + lands back on "preview"', async () => {
      const { win, doc, ptt } = boot();
      withFetch(win, [routeExact('POST', '/api/voice/send', { ok: false, error: 'too loud' })]);
      ptt.setBlob(new win.Blob(['x'], { type: 'audio/webm' }));
      ptt.pttSend();
      await flush();
      expect(ptt.getStatus()).toBe('preview');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar preview');
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Voice send failed: too loud');
    });

    it('network reject -> showError "Voice upload failed" + "preview"', async () => {
      const { win, doc, ptt } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      ptt.setBlob(new win.Blob(['x'], { type: 'audio/webm' }));
      ptt.pttSend();
      await flush();
      expect(ptt.getStatus()).toBe('preview');
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Voice upload failed');
    });
  });

  // -------------------------------------------------------------------------
  // pttLoadConfig — config math
  // -------------------------------------------------------------------------
  describe('pttLoadConfig', () => {
    it('GET /api/voice/config -> slider values + text from duck/gain', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('GET', '/api/voice/config', { duck: 0.3, gain: 1.5 })]);
      ptt.pttLoadConfig();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/voice/config')).toBe(true);
      expect(doc.getElementById('ptt-duck-slider').value).toBe('30');
      expect(doc.getElementById('ptt-duck-value').textContent).toBe('30%');
      expect(doc.getElementById('ptt-gain-slider').value).toBe('15');
      expect(doc.getElementById('ptt-gain-value').textContent).toBe('1.5x');
    });

    it('AS-IS: missing duck/gain keys leave the sliders untouched', async () => {
      const { win, doc, ptt } = boot();
      withFetch(win, [routeExact('GET', '/api/voice/config', {})]);
      // index.html defaults: duck slider 10, gain slider 50
      ptt.pttLoadConfig();
      await flush();
      expect(doc.getElementById('ptt-duck-slider').value).toBe('10');
      expect(doc.getElementById('ptt-gain-slider').value).toBe('50');
    });
  });

  // -------------------------------------------------------------------------
  // pttSaveConfig — JSON fetch payload
  // -------------------------------------------------------------------------
  describe('pttSaveConfig', () => {
    it('POST /api/voice/config JSON {duck,gain} from slider values', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/voice/config', { duck: 0.1, gain: 5 })]);
      doc.getElementById('ptt-duck-slider').value = '30';
      doc.getElementById('ptt-gain-slider').value = '15';
      ptt.pttSaveConfig();
      await flush();

      const save = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/voice/config');
      expect(save).toBeTruthy();
      // duck = 30/100 = 0.3 ; gain = 15/10 = 1.5
      expect(save.body).toEqual({ duck: 0.3, gain: 1.5 });
    });
  });

  // -------------------------------------------------------------------------
  // Settings toggle button (real #ptt-settings-btn)
  // -------------------------------------------------------------------------
  describe('#ptt-settings-btn toggle', () => {
    it('first click opens config (display flex + active class) and GETs config', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('GET', '/api/voice/config', { duck: 0.3, gain: 1.5 })]);
      const btn = doc.getElementById('ptt-settings-btn');
      const config = doc.getElementById('ptt-config');
      // index.html ships ptt-config as display:none
      expect(config.style.display).toBe('none');

      btn.onclick();
      await flush();

      expect(config.style.display).toBe('flex');
      expect(btn.classList.contains('active')).toBe(true);
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/voice/config')).toBe(true);
    });

    it('second click closes config (display none + no active class), no GET', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('GET', '/api/voice/config', { duck: 0.3, gain: 1.5 })]);
      const btn = doc.getElementById('ptt-settings-btn');
      const config = doc.getElementById('ptt-config');

      btn.onclick(); // open
      await flush();
      const getsAfterOpen = stub.calls.filter((c) => c.url === '/api/voice/config').length;

      btn.onclick(); // close
      await flush();

      expect(config.style.display).toBe('none');
      expect(btn.classList.contains('active')).toBe(false);
      // closing does not load config again
      expect(stub.calls.filter((c) => c.url === '/api/voice/config').length).toBe(getsAfterOpen);
    });
  });

  // -------------------------------------------------------------------------
  // Slider oninput — immediate text update (debounced save is behind 300ms)
  // -------------------------------------------------------------------------
  describe('slider oninput text', () => {
    it('#ptt-duck-slider oninput sets duck value text to "<value>%"', () => {
      const { doc } = boot();
      const slider = doc.getElementById('ptt-duck-slider');
      slider.value = '45';
      slider.oninput();
      expect(doc.getElementById('ptt-duck-value').textContent).toBe('45%');
    });

    it('#ptt-gain-slider oninput sets gain value text to "<value/10 .1f>x"', () => {
      const { doc } = boot();
      const slider = doc.getElementById('ptt-gain-slider');
      slider.value = '23';
      slider.oninput();
      // parseInt(23)/10 = 2.3 -> "2.3x"
      expect(doc.getElementById('ptt-gain-value').textContent).toBe('2.3x');
    });
  });

  // -------------------------------------------------------------------------
  // Discard / Send buttons (real #ptt-discard-btn / #ptt-send-btn)
  // -------------------------------------------------------------------------
  describe('preview buttons', () => {
    it('#ptt-discard-btn resets to idle', () => {
      const { doc, ptt } = boot();
      ptt.pttSetStatus('preview');
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar preview');
      doc.getElementById('ptt-discard-btn').onclick();
      expect(doc.getElementById('ptt-bar').className).toBe('ptt-bar');
      expect(doc.getElementById('ptt-label').textContent).toBe('Push to Talk');
    });

    it('#ptt-send-btn with no blob is a no-op (early return, no fetch)', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/voice/send', { ok: true, filename: 'x.webm' })]);
      ptt.setStatus('preview');
      doc.getElementById('ptt-send-btn').onclick();
      await flush();
      expect(stub.calls.length).toBe(0);
      expect(ptt.getStatus()).toBe('preview');
    });

    it('#ptt-send-btn with a blob POSTs /api/voice/send and lands on "sent"', async () => {
      const { win, doc, ptt } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/voice/send', { ok: true, filename: 'y.webm' })]);
      ptt.setBlob(new win.Blob(['x'], { type: 'audio/webm' }));
      doc.getElementById('ptt-send-btn').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'POST' && c.url === '/api/voice/send')).toBe(true);
      expect(ptt.getStatus()).toBe('sent');
    });
  });
});

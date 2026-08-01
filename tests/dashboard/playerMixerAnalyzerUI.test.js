/**
 * tests/dashboard/playerMixerAnalyzerUI.test.js
 *
 * Characterization pins for the player / monitor-mixer / analyzer slice, taken
 * before that slice was extracted out of the app.js IIFE and kept green through
 * the extraction. Each region now has its own module:
 *
 *   - player        player.js   (overlay state machine, standby overlay, mute
 *                               button, HLS bootstrap, page-lifecycle recovery)
 *   - monitor mixer mixer.js
 *   - analyzer      analyzer.js (including setPlayerMuted)
 *
 * They pin AS-IS observable behaviour and staying green across the move is what
 * proved zero behaviour change. Nothing here fixes anything. Code references
 * below name modules and functions rather than line numbers, which rot.
 *
 * CONSUMER-SHAPED. Every pin is driven through a real entry point — a dispatched
 * media event on <video id="studio-player">, a click on a real button, a WS frame
 * on the boot socket, or the login flow that fires the /api/status poll. The two
 * new closure seams (window.__appAudio.getAzInited, window.__appStudio
 * .getTrackStartedAt) are read only as SECONDARY confirmation beside a DOM
 * assertion, never as the primary pin.
 *
 * NATIVE-HLS BRANCH: appBoot stubs Hls.isSupported() to false, so initPlayer
 * takes the native-HLS path (player.js initPlayer) and useNativeHls stays true.
 * That is what makes the <video> 'error' handler (player.js bindMediaListeners)
 * live in these tests —
 * it returns early unless useNativeHls. The hls.js branch is unreachable here and
 * is deliberately not pinned.
 *
 * TIMERS: app.js resolves setTimeout against win.setTimeout in the jsdom realm,
 * which vi.useFakeTimers() does not intercept. These pins use the capture-spy
 * recipe from wsReconnectUI.test.js:22-30 — record the delay, return a non-zero
 * id, never schedule — so a recovery path that schedules a restart cannot
 * actually restart the player mid-test.
 *
 * CLOCK: the same realm trap applies to Date. win.Date is NOT the node-side
 * Date, so app.js's Date.now() is unaffected by patching globalThis.Date.now —
 * the page-lifecycle pins advance win.Date.now instead (see goHiddenThenVisible).
 * Worth knowing before extraction: any module that reads the clock inherits this.
 *
 * WEBAUDIO: appBoot's AudioContext stub is deliberately minimal, so azInit's try
 * block throws and the analyzer never latches. Tests that need the SUCCESS branch
 * install a fuller AudioContext locally (installWorkingAudioContext below). The
 * FAILURE-branch test extends the stub too, but with close() ONLY — just enough
 * for azInit's catch to complete, so the failure is the one under test rather
 * than a secondary throw out of the error handler. appBoot.js is not modified.
 *
 * PHASE-1 REACHABILITY — three regions of this slice have no live consumer in the
 * shipped markup, which is itself pinned so the extraction cannot quietly drop
 * the guards that make them harmless:
 *
 *   - The ENTIRE monitor mixer UI (#monitor-mixer and every mm-* control) sits
 *     inside a PHASE 2 HTML comment, so every element it is wired to is null.
 *     startMic has exactly two call sites and both are behind that markup: the
 *     mm-mic-btn click listener (mixer.js bindControls, bound only under
 *     `if (mmMicBtn)`) and `setTimeout(startMic, 100)` in the mic-input-select
 *     change listener (also bindControls, under `if (micInputSelect)`). Neither
 *     listener ever binds, so startMic never runs — which makes its
 *     `if (!azInited) azInit()` hop, the monitor meters, and the whole auto-duck
 *     envelope follower unreachable in Phase 1.
 *   - pendingModeSwitch can never become true: the only writer (applyUiMode in
 *     app.js) is
 *     gated on streamMode === 'live', but both applyUiMode callers bail out
 *     unless streamMode === 'standby'. Its hard-block branch in hideLoading is
 *     therefore dead.
 *   - azUpdateGlow needs a laid-out canvas (azW/azH >= 1) and a running rAF
 *     loop; jsdom gives neither, so trackStartedAt's second reader is pinned
 *     only through updateTrackProgress.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot and rethrow a load error, so a boot failure fails loudly. */
function boot() {
  const { win, doc, loadError } = bootWindow();
  if (loadError) throw loadError;
  return { win, doc };
}

/** Drive the boot WebSocket, the same seam the broadcast pins use. */
function wsSender(win) {
  const ws = win.__appWs.getWs();
  return (msg) => ws.onmessage({ data: JSON.stringify(msg) });
}

/** Server-shaped 'init'/'status' payload for a phase (see broadcastUI.test.js). */
function statePayload(streamMode, broadcast, visualMode) {
  return {
    streamControl: { streaming: streamMode !== 'standby', broadcast },
    streamMode: { mode: streamMode, standbyVisual: null },
    visualMode: { mode: visualMode || 'visual-radio' },
  };
}

/**
 * Freeze the jsdom realm clock at `at` and return it. updateTrackProgress
 * derives the elapsed seconds and the bar width from Date.now() at call time, so
 * without this the few milliseconds between building the payload and asserting
 * leak into the percentage (25% vs 25.0008%). Must patch win.Date, not the
 * node-side Date — see the CLOCK note in the header.
 */
function freezeClock(win, at) {
  win.Date.now = () => at;
  return at;
}

/**
 * Capture-spy over win.setTimeout: records every delay, schedules nothing.
 * Returns the array of recorded delays.
 */
function captureTimers(win) {
  const delays = [];
  win.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
  return delays;
}

/**
 * Widen the appBoot AudioContext stub so azInit's try block completes and the
 * analyzer actually latches. appBoot ships only createAnalyser /
 * createMediaElementSource / createGain, so azInit throws on
 * createChannelSplitter and falls into its catch. These extra members are the
 * minimum azInit (analyzer.js) touches on the success path.
 */
function installWorkingAudioContext(win) {
  const Base = win.AudioContext;
  win.AudioContext = class extends Base {
    constructor() {
      super();
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = {};
    }
    close() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    createChannelSplitter() { return { connect() {} }; }
    createMediaElementSource() { return { connect() {} }; }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, setTargetAtTime() {} }, connect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 0, frequencyBinCount: 32, smoothingTimeConstant: 0,
        connect() {}, disconnect() {},
        getByteFrequencyData() {}, getByteTimeDomainData() {},
      };
    }
  };
  win.webkitAudioContext = win.AudioContext;
}

/** The overlay state updateBroadcastUI's siblings drive. */
function overlayState(doc) {
  const overlay = doc.getElementById('player-overlay');
  return {
    visible: overlay.classList.contains('visible'),
    text: doc.getElementById('player-overlay-text').textContent,
  };
}

/** Log in through the real overlay, which fires loadBroadcastState(). */
async function loginWithStatus(win, doc, status) {
  const { fetch } = makeFetchStub([
    routeExact('POST', '/api/auth/verify', { ok: true }),
    routeExact('GET', '/api/status', status),
  ]);
  win.fetch = fetch;
  doc.getElementById('login-token').value = 'test-token';
  doc.getElementById('login-btn').click();
  await flush(20);
}

describe('player overlay state machine', () => {
  // showLoading / hideLoading and the lock fields: player.js.

  it('ships visible from the markup, before any showLoading call', () => {
    const { doc } = boot();
    // The #player-overlay markup in index.html hard-codes class="visible" and
    // the placeholder text, so
    // the overlay is up from first paint rather than from a showLoading call.
    expect(overlayState(doc)).toEqual({ visible: true, text: 'Loading stream...' });
  });

  it("the video element's canplay event hides the overlay", () => {
    const { win, doc } = boot();
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    expect(overlayState(doc).visible).toBe(false);
  });

  it('timeupdate hides the overlay and arms the 4s buffering timer', () => {
    const { win, doc } = boot();
    const delays = captureTimers(win);
    doc.getElementById('studio-player').dispatchEvent(new win.Event('timeupdate'));
    expect(overlayState(doc).visible).toBe(false);
    expect(delays).toEqual([4000]);
  });

  it('timeupdate is a no-op while the standby overlay is up', async () => {
    const { win, doc } = boot();
    // An idle poll turns the static noise on (noiseActive), which is the guard
    // in player.js's timeupdate listener — it returns before hiding anything.
    await loginWithStatus(win, doc, statePayload('standby', false));
    expect(doc.getElementById('standby-overlay').classList.contains('active')).toBe(true);

    const delays = captureTimers(win);
    doc.getElementById('studio-player').dispatchEvent(new win.Event('timeupdate'));
    expect(overlayState(doc).visible).toBe(true);
    expect(delays).toEqual([]);
  });

  it('a native player error shows Reconnecting and schedules a 2s restart', () => {
    const { win, doc } = boot();
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    doc.getElementById('studio-player').dispatchEvent(new win.Event('error'));

    expect(overlayState(doc)).toEqual({ visible: true, text: 'Reconnecting...' });
    // showLoading arms its own 20s safety net first, then the error handler
    // schedules restartPlayer at 2s (player.js showLoading and the media
    // 'error' listener in bindMediaListeners).
    expect(delays).toEqual([20000, 2000]);
  });

  it('a native player error is ignored while armed', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('armed', false) });
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    doc.getElementById('studio-player').dispatchEvent(new win.Event('error'));

    // player.js's 'error' listener returns before showLoading — the poster
    // loops normally.
    expect(overlayState(doc).visible).toBe(false);
    expect(delays).toEqual([]);
  });
});

describe('page lifecycle recovery', () => {
  // visibilitychange and the bfcache pageshow: player.js bindPageLifecycle.

  it('a bfcache restore restarts the player behind a locked overlay', () => {
    const { win, doc } = boot();
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    const evt = new win.Event('pageshow');
    Object.defineProperty(evt, 'persisted', { value: true });
    win.dispatchEvent(evt);

    expect(overlayState(doc)).toEqual({ visible: true, text: 'Loading stream...' });
    // restartPlayer's showLoading passes lockMs 3000 but only the 20s safety
    // net reaches setTimeout; the lock is a timestamp, not a timer.
    expect(delays).toEqual([20000]);
  });

  it('a pageshow without persisted is ignored', () => {
    const { win, doc } = boot();
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    win.dispatchEvent(new win.Event('pageshow'));

    expect(overlayState(doc).visible).toBe(false);
    expect(delays).toEqual([]);
  });

  it('returning to a visible page does not recover while in standby', () => {
    const { win, doc } = boot();
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    // The 5s absence matters: it is past the 3s staleness threshold, so the
    // standby guard in player.js bindPageLifecycle is the ONLY thing preventing
    // a restart. Without
    // an advanced clock this pin would pass with that guard deleted.
    goHiddenThenVisible(win, doc, 5000);

    expect(overlayState(doc).visible).toBe(false);
    expect(delays).toEqual([]);
  });

  it('returning to a visible page while live restarts a stale stream', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('live', true) });
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    goHiddenThenVisible(win, doc, 5000);

    expect(overlayState(doc)).toEqual({ visible: true, text: 'Loading stream...' });
    expect(delays).toEqual([20000]);
  });

  it('a brief absence while live only retries play, without an overlay', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('live', true) });
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    goHiddenThenVisible(win, doc, 0);

    // Under the 3s threshold bindPageLifecycle takes the tryPlay branch,
    // which shows nothing and schedules nothing while play() resolves.
    expect(overlayState(doc).visible).toBe(false);
    expect(delays).toEqual([]);
  });
});

/**
 * Drive a hide/show pair of visibilitychange events, optionally advancing the
 * clock so the handler sees `awayMs` of absence.
 *
 * Two jsdom realm traps here. document.hidden is a prototype getter, so it is
 * redefined on the instance around each dispatch. And app.js's `Date.now()`
 * resolves to win.Date.now — the jsdom realm ships its OWN Date, so patching
 * the node-side Date.now does nothing at all (the same class of trap as
 * setTimeout). The clock advance therefore goes on win.Date.
 */
function goHiddenThenVisible(win, doc, awayMs) {
  const realNow = win.Date.now;
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  doc.dispatchEvent(new win.Event('visibilitychange'));
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  if (awayMs) {
    win.Date.now = () => realNow() + awayMs;
  }
  try {
    doc.dispatchEvent(new win.Event('visibilitychange'));
  } finally {
    win.Date.now = realNow;
  }
}

describe('standby overlay and the player mute path', () => {
  // startStaticNoise/stopStaticNoise (player.js) and setPlayerMuted
  // (analyzer.js — it drives the analyzer gain node).

  it('an idle poll raises the standby overlay and leaves the player muted', async () => {
    const { win, doc } = boot();
    expect(doc.getElementById('studio-player').muted).toBe(true);

    await loginWithStatus(win, doc, statePayload('standby', false));

    expect(doc.getElementById('standby-overlay').classList.contains('active')).toBe(true);
    expect(doc.getElementById('studio-player').muted).toBe(true);
  });

  it('a later playing poll drops the standby overlay but does not unmute', async () => {
    const { win, doc } = boot();
    await loginWithStatus(win, doc, statePayload('standby', false));
    expect(doc.getElementById('standby-overlay').classList.contains('active')).toBe(true);

    // A second login re-fires loadBroadcastState with the new server state.
    await loginWithStatus(win, doc, statePayload('live', false));

    expect(doc.getElementById('standby-overlay').classList.contains('active')).toBe(false);
    // The poll restores mute from the button's own class (loadBroadcastState in
    // app.js), which
    // is still muted here because no gesture has touched it.
    expect(doc.getElementById('studio-player').muted).toBe(true);
    expect(win.__appStudio.getUserInteracted()).toBe(false);
  });

  it('the mute button toggles the media element, its glyph and its title', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);
    const btn = doc.getElementById('player-mute-btn');
    const player = doc.getElementById('studio-player');

    btn.click();
    expect(player.muted).toBe(false);
    expect(btn.classList.contains('unmuted')).toBe(true);
    expect(btn.title).toBe('Mute');
    expect(btn.innerHTML).toBe('\u{1F50A}');

    btn.click();
    expect(player.muted).toBe(true);
    expect(btn.classList.contains('unmuted')).toBe(false);
    expect(btn.title).toBe('Unmute');
    expect(btn.innerHTML).toBe('\u{1F507}');
  });

  it('the mute button records the user gesture before unmuting', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);
    expect(win.__appStudio.getUserInteracted()).toBe(false);

    doc.getElementById('player-mute-btn').click();

    // setPlayerMuted refuses to unmute without a gesture (analyzer.js), and the
    // handler sets the flag first (player.js bindMuteButton) so its own unmute
    // always passes.
    // Every other reachable setPlayerMuted(false) caller — the PLAY button and
    // its async continuations — likewise sets the flag first, so the guard's
    // blocking branch has no consumer that can trip it.
    expect(win.__appStudio.getUserInteracted()).toBe(true);
    expect(doc.getElementById('studio-player').muted).toBe(false);
  });

  it('PLAY from preview opens the gate and unmutes through the same path', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('live', false) });
    expect(doc.getElementById('btn-play').disabled).toBe(false);

    doc.getElementById('btn-play').click();

    expect(win.__appStudio.getUserInteracted()).toBe(true);
    expect(doc.getElementById('studio-player').muted).toBe(false);
    expect(doc.getElementById('player-mute-btn').classList.contains('unmuted')).toBe(true);
  });
});

describe('analyzer init latch (window.__appAudio.getAzInited)', () => {
  it('is false on boot — nothing has supplied a user gesture yet', () => {
    const { win } = boot();
    expect(typeof win.__appAudio.getAzInited).toBe('function');
    expect(win.__appAudio.getAzInited()).toBe(false);
    expect(win.__appAudio.getAudioCtx()).toBe(null);
  });

  it('the mute button latches the analyzer when the audio graph builds', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);

    doc.getElementById('player-mute-btn').click();

    expect(win.__appAudio.getAzInited()).toBe(true);
    // The latch is only meaningful because the graph came up with it.
    expect(win.__appAudio.getAudioCtx()).not.toBe(null);
    expect(win.__appAudio.getMainAnalyser()).not.toBe(null);
    expect(doc.getElementById('analyzer-info').textContent).toBe('48kHz');
  });

  it('a failing audio graph leaves the latch clear and tears the context down', () => {
    const { win, doc } = boot();
    // appBoot's stub plus close() and nothing else: azInit still throws on
    // createChannelSplitter and falls into its catch, which nulls azAudioCtx back
    // out. close() is exactly what that catch needs — the bare appBoot stub lacks
    // it, so the catch itself would throw and abort the whole click handler
    // (that secondary throw is what the ARM pins in broadcastUI.test.js work
    // around). Adding only close() keeps the failure under test the real one.
    const Base = win.AudioContext;
    win.AudioContext = class extends Base { close() { return Promise.resolve(); } };
    win.webkitAudioContext = win.AudioContext;

    doc.getElementById('player-mute-btn').click();

    expect(win.__appAudio.getAzInited()).toBe(false);
    expect(win.__appAudio.getAudioCtx()).toBe(null);
    // The mute toggle itself still completed — azInit failure is not fatal.
    expect(doc.getElementById('studio-player').muted).toBe(false);
  });

  it('the analyzer mode buttons latch it too, and move the active class', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);
    const modes = Array.from(doc.querySelectorAll('.az-mode'));
    expect(modes.map((b) => b.dataset.azmode)).toEqual(['spectrum', 'spectrogram', 'scope', 'levels']);
    expect(modes[0].classList.contains('active')).toBe(true);

    modes[2].click();

    expect(win.__appAudio.getAzInited()).toBe(true);
    expect(modes.filter((b) => b.classList.contains('active')).map((b) => b.dataset.azmode))
      .toEqual(['scope']);
  });

  it('latches once — a second gesture does not rebuild the graph', () => {
    const { win, doc } = boot();
    installWorkingAudioContext(win);
    const btn = doc.getElementById('player-mute-btn');

    btn.click();
    const ctx = win.__appAudio.getAudioCtx();
    btn.click();

    expect(win.__appAudio.getAzInited()).toBe(true);
    expect(win.__appAudio.getAudioCtx()).toBe(ctx);
  });

  it('the ON/OFF toggle collapses the analyzer without touching the latch', () => {
    const { win, doc } = boot();
    const toggle = doc.getElementById('az-toggle');
    const wrap = doc.getElementById('analyzer-wrap');

    toggle.click();
    expect(toggle.textContent).toBe('OFF');
    expect(wrap.classList.contains('collapsed')).toBe(true);
    expect(win.__appAudio.getAzInited()).toBe(false);

    toggle.click();
    expect(toggle.textContent).toBe('ON');
    expect(wrap.classList.contains('collapsed')).toBe(false);
  });
});

describe('track clock seam (window.__appStudio.getTrackStartedAt)', () => {
  it('is zero before any audio frame arrives', () => {
    const { win } = boot();
    expect(typeof win.__appStudio.getTrackStartedAt).toBe('function');
    expect(win.__appStudio.getTrackStartedAt()).toBe(0);
  });

  it('a WS audio frame drives the transport progress bar', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('live', true) });

    const now = freezeClock(win, 1700000000000);
    const startedAt = now - 30000;
    send({ type: 'audio', data: { filename: 'track.mp3', startedAt, duration: 120 } });

    expect(doc.getElementById('transport-elapsed').textContent).toBe('0:30');
    expect(doc.getElementById('transport-duration').textContent).toBe('2:00');
    expect(doc.getElementById('transport-bar-fill').style.width).toBe('25%');
    expect(win.__appStudio.getTrackStartedAt()).toBe(startedAt);
  });

  it('an audio frame arriving in standby is dropped before the clock is set', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('standby', false) });

    send({ type: 'audio', data: { filename: 'track.mp3', startedAt: Date.now(), duration: 120 } });

    // updateAudio (app.js) returns early for standby/armed/arming, so neither the
    // clock nor the transport row moves.
    expect(win.__appStudio.getTrackStartedAt()).toBe(0);
    expect(doc.getElementById('transport-bar-fill').style.width).toBe('');
  });

  it('a frame without startedAt leaves the previous clock in place', () => {
    const { win, doc } = boot();
    const send = wsSender(win);
    send({ type: 'init', data: statePayload('live', true) });

    const startedAt = freezeClock(win, 1700000000000) - 10000;
    send({ type: 'audio', data: { filename: 'a.mp3', startedAt, duration: 100 } });
    send({ type: 'audio', data: { filename: 'b.mp3', duration: 100 } });

    // The `if (data.startedAt)` guard in updateAudio keeps the old value rather than
    // resetting the clock, so the bar keeps advancing from the old track.
    expect(win.__appStudio.getTrackStartedAt()).toBe(startedAt);
    expect(doc.getElementById('transport-elapsed').textContent).toBe('0:10');
  });
});

describe('monitor mixer is absent in Phase 1', () => {
  // The whole section (now mixer.js) is guarded on DOM that index.html
  // ships inside a PHASE 2 comment. These pins lock that in, so the extraction
  // keeps the null guards rather than assuming the controls exist.

  it('none of the monitor mixer controls exist in the shipped markup', () => {
    const { doc } = boot();
    const ids = [
      'monitor-mixer', 'mm-status-badge', 'mm-mic-btn', 'mm-mon-btn', 'mm-duck-btn',
      'mic-input-select', 'mic-output-select',
      'mm-mic-fader', 'mm-music-fader', 'mm-master-fader',
      'mm-mic-meter', 'mm-music-meter', 'mm-master-meter',
    ];
    for (const id of ids) {
      expect(doc.getElementById(id), id + ' should be absent in Phase 1').toBe(null);
    }
  });

  it('boots cleanly with every mixer guard falling through', () => {
    // updateMonitorUI, enumerateMicDevices and the three click bindings all run
    // or bind at load; with the DOM absent they must no-op rather than throw.
    const { win } = boot();
    expect(win.__appAudio.getGainNode()).toBe(null);
    expect(win.__appAudio.getAzInited()).toBe(false);
  });

  it('the mic never opens, so the analyzer is not latched through the mixer', async () => {
    const { win } = boot();
    installWorkingAudioContext(win);
    // startMic's only caller is the mm-mic-btn listener, which never binds.
    // getUserMedia is stubbed and would resolve if anything called it.
    await flush(20);
    expect(win.__appAudio.getAzInited()).toBe(false);
    expect(win.__appAudio.getAudioCtx()).toBe(null);
  });
});

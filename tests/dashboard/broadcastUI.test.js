/**
 * tests/dashboard/broadcastUI.test.js
 *
 * Characterization pins for the BROADCAST REPAINT CONTRACT, taken while it
 * still lived inside the app.js IIFE: the pair deriveUiMode() (now broadcast.js, delegating
 * to FRUtils.deriveUiMode at utils.js:153-158) + updateBroadcastUI()
 * (broadcast.js, reading the phase from its getBroadcastPhase
 * -> FRUtils.getBroadcastPhase at utils.js:133-142, and the hint table
 * MODE_HINTS, also in broadcast.js). These pin the AS-IS observable contract
 * BEFORE the region was extracted into a module; staying green across the move
 * is what proved zero behaviour change.
 *
 * CONSUMER-SHAPED. The pair is never called by a test directly. Both real
 * consumers do the same two calls back to back and are driven end to end here:
 *
 *   1. The WebSocket 'init' frame — the hub's 'init' case (wsHub.js handleMessage,
 *      which calls the injected handler). Driven by boot-time socket.onmessage({ data }) with
 *      a real server-shaped JSON payload. onmessage is a plain instance property
 *      assigned in connectWs (wsHub.js), and the appBoot WebSocket stub
 *      (appBoot.js:63-68) never fires anything on its own, so the test supplies
 *      the frame.
 *
 *   2. The /api/status poll — loadBroadcastState (broadcast.js, which ends with
 *      the same pair). Reached WITHOUT any new hook: FRAuth.init's onLogin
 *      callback (app.js wiring) calls FRBroadcast.loadBroadcastState(), and onLogin fires
 *      from doLogin (auth.js:111-134). So the test types a token into the real
 *      #login-token input and clicks the real #login-btn; the fetch stub answers
 *      /api/auth/verify and then /api/status. Boot's own loadBroadcastState()
 *      call in broadcast.js's bindMachine is left pending forever by appBoot's never-resolving
 *      default fetch, and its 15s setInterval is unreachable in a
 *      test, so the login flow is the only usable entry into this consumer.
 *
 * ASSERTIONS are observable effects only: transport button text/disabled/display,
 * the mode-tag element, the hint element, the queue chrome, the .studio-layout /
 * .mode-card class state written by updateModeUI (broadcast.js), and which
 * endpoint each swapped skip/clear onclick actually calls through the fetch stub.
 * window.__appDrift.getBroadcastState() is read only as a SECONDARY confirmation
 * next to a DOM assertion, never as the primary pin.
 *
 * REACHING THE 'arming' PHASE: `arming` is a client-only flag — no server payload
 * sets it (getBroadcastPhase checks state.arming first, utils.js:134). Its sole
 * writer on the way up is the real ARM button handler (broadcast.js), so the
 * arming pins click #btn-arm and then drive an 'init' frame through consumer 1.
 * The click has to happen on a freshly booted window: updateBroadcastUI disables
 * ARM in every phase but idle, and a disabled button runs no activation
 * behaviour. With appBoot's never-resolving default fetch the ARM API chain stays
 * pending, so the flag holds for the duration of the test. btnArm.onclick calls
 * the analyzer init hop BEFORE setting the flag, and azInit's own error path
 * (now analyzer.js) calls azAudioCtx.close(), which the appBoot AudioContext
 * stub does not implement — that secondary throw would escape the handler and
 * abort ARM. The arming helper therefore widens the stub with a close()
 * returning a promise.
 * This is a browser-API completion local to this file; appBoot.js is untouched.
 *
 * EXTRACTION DONE: the region has since moved out of the app.js IIFE into
 * broadcast.js (window.FRBroadcast), alongside the other extracted domains.
 * Every pin here is written against observable effects, and they stayed green
 * across that move untouched — which is what proved it behaviour-neutral.
 *
 * AS-IS QUIRKS PINNED HERE — each of these locks in behaviour that looks wrong
 * on purpose. Do not "fix" one to make a pin greener; change it in a separate
 * behaviour-change commit and update the pin with it.
 *
 *   - PLAY vs the button-state table (the comment block above updateBroadcastUI in
 *     broadcast.js): the table's idle row
 *     says PLAY:on but the code disables PLAY in idle, and its playing row says
 *     PLAY:off but the code enables PLAY while playing. Two rows, same button,
 *     opposite directions. The idle hint text also invites the user to press a
 *     button that is disabled in that phase. The pins follow the code.
 *   - Stale sub-pill highlight in takeover: uiMode 'takeover' has no matching
 *     .mode-card in Phase 1 markup, so updateModeUI's pill loop never runs and
 *     whichever pill was lit stays lit while no card is highlighted at all.
 *   - Live Mode Bar write is inert: #live-mode-bar sits inside a Phase 3 HTML
 *     comment, so updateModeUI's Live Mode Bar display write is swallowed by its null
 *     guard. Pinned as null so a Phase 3 markup change fails loudly here.
 *   - Skip/clear are bound ONCE, by queue.js at boot, and decide music-vs-video
 *     at click time from the broadcast state. updateBroadcastUI no longer
 *     reassigns them — it owns only the chrome (labels, placeholder, disabled).
 *     Pinned as: stable handler identity across repaints in both modes, and the
 *     dispatch itself proven both ways through the endpoints it POSTs to.
 *   - Synthetic 'browser-mic' payloads: a real uiSubMode that the server's
 *     visualMode can never be, used to reach the defensive fallback arms in
 *     MODE_HINTS and deriveUiMode. Marked at each use site.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Server-shaped 'init' / '/api/status' payload for a given phase + visual mode.
 * Both consumers read the same three sub-objects (streamControl / streamMode /
 * visualMode), so one builder feeds both.
 *
 * The 'arming' phase has no server representation — it is produced by the ARM
 * click; the payload below is the standby state the UI is in while arming.
 */
function payloadFor(phase, visualMode) {
  const byPhase = {
    idle: { streaming: false, broadcast: false, mode: 'standby' },
    arming: { streaming: false, broadcast: false, mode: 'standby' },
    armed: { streaming: true, broadcast: false, mode: 'armed' },
    broadcasting: { streaming: true, broadcast: true, mode: 'armed' },
    playing: { streaming: true, broadcast: false, mode: 'live' },
    live: { streaming: true, broadcast: true, mode: 'live' },
  };
  const p = byPhase[phase];
  return {
    streamControl: { streaming: p.streaming, broadcast: p.broadcast },
    streamMode: { mode: p.mode, standbyVisual: null },
    visualMode: { mode: visualMode },
  };
}

/**
 * Boot a window and return it plus a driver for the WS 'init' consumer.
 *
 * A load error is rethrown rather than handed back: every pin in this file
 * assumes app.js evaluated, so a boot failure should fail loudly here instead of
 * turning into a pile of confusing DOM assertion mismatches.
 */
function bootWithInit() {
  const { win, doc, loadError } = bootWindow();
  if (loadError) throw loadError;
  const ws = win.__appWs.getWs();
  function sendInit(data) {
    ws.onmessage({ data: JSON.stringify({ type: 'init', data }) });
  }
  return { win, doc, sendInit };
}

/**
 * Put the app into the 'arming' phase through the real ARM button, then repaint
 * via the WS 'init' consumer with the given visual mode. See the file header for
 * why the AudioContext stub is widened here.
 */
function enterArming(win, doc, sendInit, visualMode) {
  const BaseAudioContext = win.AudioContext;
  win.AudioContext = class extends BaseAudioContext {
    close() { return Promise.resolve(); }
  };
  win.webkitAudioContext = win.AudioContext;
  doc.getElementById('btn-arm').click();
  sendInit(payloadFor('arming', visualMode));
}

/** Everything updateBroadcastUI writes to the transport row, in one object. */
function transportSnapshot(doc) {
  const tag = doc.getElementById('broadcast-mode-tag');
  const arm = doc.getElementById('btn-arm');
  const broadcast = doc.getElementById('btn-broadcast');
  return {
    tagText: tag.textContent,
    tagClass: tag.className,
    armDisabled: arm.disabled,
    armDisplay: arm.style.display,
    playDisabled: doc.getElementById('btn-play').disabled,
    stopDisabled: doc.getElementById('btn-stop').disabled,
    broadcastDisabled: broadcast.disabled,
    broadcastText: broadcast.textContent,
    skipDisabled: doc.getElementById('skip-btn').disabled,
  };
}

/** Everything updateBroadcastUI writes to the queue chrome. */
function queueChrome(doc) {
  return {
    panelTitle: doc.getElementById('queue-panel-title').textContent,
    selectorTitle: doc.getElementById('queue-selector-title').textContent,
    searchPlaceholder: doc.getElementById('queue-search').placeholder,
  };
}

/**
 * Everything updateModeUI (broadcast.js) writes, in one object: the layout
 * mode/sub-mode classes, the card highlight, the sub-pill highlight, the
 * on-air card lock and the Live Mode Bar, both in updateModeUI.
 *
 * liveModeBarDisplay is null whenever #live-mode-bar is absent from the DOM.
 * Phase 1 ships that element inside a Phase 3 HTML comment, so liveModeSettings
 * resolves to null and the `if (liveModeSettings)` guard makes the
 * write inert — pinning null is what locks the guard in place.
 */
function modeClasses(doc) {
  const layout = doc.querySelector('.studio-layout');
  const radioCard = doc.querySelector('.mode-card[data-mode="radio"]');
  const liveModeBar = doc.getElementById('live-mode-bar');
  return {
    layout: Array.from(layout.classList).sort(),
    radioCardActive: radioCard.classList.contains('active'),
    radioCardLocked: radioCard.classList.contains('mode-locked'),
    activePills: Array.from(doc.querySelectorAll('.mode-sub-pill'))
      .filter((pill) => pill.classList.contains('active'))
      .map((pill) => pill.dataset.submode),
    liveModeBarDisplay: liveModeBar ? liveModeBar.style.display : null,
  };
}

/**
 * Queue ACTION endpoints the fetch stub saw, in call order. The trailing slash
 * in 'queue/' is load-bearing: it keeps the skip/clear actions and drops the
 * bare /api/queue and /api/video-queue reload GETs, so a test asserting which
 * button fired is not perturbed by the reload each handler triggers.
 */
function queueCalls(calls) {
  return calls
    .filter((c) => c.url.indexOf('queue/') !== -1)
    .map((c) => c.method + ' ' + c.url);
}

/** Every queue request, action and reload alike — the reloads kept. */
function queueTraffic(calls) {
  return calls
    .filter((c) => c.url.indexOf('/api/queue') === 0 || c.url.indexOf('/api/video-queue') === 0)
    .map((c) => c.method + ' ' + c.url);
}

/**
 * Boot a window wired for the skip/clear handler pins.
 *
 * Both handler pairs gate all of their work behind `if (data.ok)`, so the
 * action routes answer { ok: true } — otherwise the success branches never run
 * and the tests would pin nothing but the POST itself. The reload routes answer
 * an empty queue so renderQueue has something valid to draw.
 *
 * Timers use the capture-spy recipe from wsReconnectUI.test.js:22-30: app.js
 * resolves setTimeout against win.setTimeout in the jsdom realm, which
 * vi.useFakeTimers() does not intercept. The spy RECORDS each delay and returns
 * a non-zero id without scheduling, so the deferred reloads are observable as
 * delays without ever firing inside the test.
 *
 * `reset()` clears both recorders — call it after a repaint so only the traffic
 * a clicked handler produced is under assertion.
 */
function bootQueueHarness(overrideRoutes) {
  const { win, doc, sendInit } = bootWithInit();
  const { fetch, calls } = makeFetchStub([
    ...(overrideRoutes || []),
    routeExact('POST', '/api/queue/skip', { ok: true }),
    routeExact('POST', '/api/queue/clear', { ok: true }),
    routeExact('POST', '/api/video-queue/skip', { ok: true }),
    routeExact('POST', '/api/video-queue/clear', { ok: true }),
    routeExact('GET', '/api/queue', []),
    routeExact('GET', '/api/video-queue', []),
  ]);
  win.fetch = fetch;

  const delays = [];
  win.setTimeout = (fn, ms) => { delays.push(ms); return 1; };

  return {
    win,
    doc,
    sendInit,
    calls,
    delays,
    skipBtn: doc.getElementById('skip-btn'),
    clearBtn: doc.getElementById('clear-queue-btn'),
    reset() {
      calls.length = 0;
      delays.length = 0;
    },
  };
}

/**
 * Drive consumer 2: log in through the real overlay so FRAuth's onLogin fires
 * loadBroadcastState(), which fetches /api/status and repaints. Returns the
 * recorded fetch calls.
 */
async function loginAndPoll(win, doc, statusPayload) {
  const { fetch, calls } = makeFetchStub([
    routeExact('POST', '/api/auth/verify', { ok: true }),
    routeExact('GET', '/api/status', statusPayload),
  ]);
  win.fetch = fetch;
  doc.getElementById('login-token').value = 'test-token';
  doc.getElementById('login-btn').click();
  await flush(20);
  return calls;
}

describe('broadcast repaint via the WS init consumer', () => {
  // The hub's 'init' case (wsHub.js) driving updateBroadcastUI (broadcast.js).

  it('idle: ARM is the only enabled control and stays visible', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'visual-radio'));
    // playDisabled: true here deliberately contradicts both the button-state
    // button-state table above updateBroadcastUI (which documents idle as PLAY:on) and
    // the idle hint text, which invites the user to press PLAY. Known doc/UX
    // divergence, pinned as-is and tracked in the Bug Register.
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'OFF',
      tagClass: 'mode-tag off',
      armDisabled: false,
      armDisplay: '',
      playDisabled: true,
      stopDisabled: true,
      broadcastDisabled: true,
      broadcastText: 'BROADCAST',
      skipDisabled: true,
    });
  });

  it('arming: ARM stays visible but disabled, STOP is the only way out', () => {
    const { win, doc, sendInit } = bootWithInit();
    enterArming(win, doc, sendInit, 'visual-radio');
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'ARMING',
      tagClass: 'mode-tag arming',
      armDisabled: true,
      armDisplay: '',
      playDisabled: true,
      stopDisabled: false,
      broadcastDisabled: true,
      broadcastText: 'BROADCAST',
      skipDisabled: true,
    });
  });

  it('armed: ARM is hidden, PLAY and BROADCAST open up', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('armed', 'visual-radio'));
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'ARMED',
      tagClass: 'mode-tag ready',
      armDisabled: true,
      armDisplay: 'none',
      playDisabled: false,
      stopDisabled: false,
      broadcastDisabled: false,
      broadcastText: 'BROADCAST',
      skipDisabled: true,
    });
  });

  it('playing: SKIP opens up, PLAY stays enabled, BROADCAST still reads BROADCAST', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('playing', 'visual-radio'));
    // playDisabled: false is the second half of the PLAY divergence noted in the
    // header — the button-state table documents this row as PLAY:off.
    // Known doc/UX divergence, pinned as-is and tracked in the Bug Register.
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'PREVIEW',
      tagClass: 'mode-tag preview',
      armDisabled: true,
      armDisplay: 'none',
      playDisabled: false,
      stopDisabled: false,
      broadcastDisabled: false,
      broadcastText: 'BROADCAST',
      skipDisabled: false,
    });
  });

  it('broadcasting: BROADCAST flips to END, SKIP goes back to disabled', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('broadcasting', 'visual-radio'));
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'ON AIR',
      tagClass: 'mode-tag broadcasting',
      armDisabled: true,
      armDisplay: 'none',
      playDisabled: false,
      stopDisabled: false,
      broadcastDisabled: false,
      broadcastText: 'END',
      skipDisabled: true,
    });
  });

  it('live: PLAY is disabled again while BROADCAST reads END and SKIP is enabled', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('live', 'visual-radio'));
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'LIVE',
      tagClass: 'mode-tag live',
      armDisabled: true,
      armDisplay: 'none',
      playDisabled: true,
      stopDisabled: false,
      broadcastDisabled: false,
      broadcastText: 'END',
      skipDisabled: false,
    });
  });

  it('repaints in place as consecutive init frames walk the phases', () => {
    const { doc, sendInit } = bootWithInit();
    const tags = [];
    for (const phase of ['idle', 'armed', 'playing', 'broadcasting', 'live', 'idle']) {
      sendInit(payloadFor(phase, 'visual-radio'));
      tags.push(doc.getElementById('broadcast-mode-tag').textContent);
    }
    expect(tags).toEqual(['OFF', 'ARMED', 'PREVIEW', 'ON AIR', 'LIVE', 'OFF']);
  });
});

describe('MODE_HINTS text per phase and visual mode', () => {
  // MODE_HINTS lives in broadcast.js; updateBroadcastUI renders from it.

  /** Walk every phase for one visual mode and collect the rendered hint. */
  function hintsFor(visualMode) {
    const hints = {};
    // 'arming' needs its own window: ARM is only clickable while the transport
    // is idle (updateBroadcastUI disables it in every other phase, and a
    // disabled button runs no activation behaviour), and nothing on the server
    // side clears the flag once set.
    const arming = bootWithInit();
    enterArming(arming.win, arming.doc, arming.sendInit, visualMode);
    hints.arming = arming.doc.getElementById('transport-mode-hint').textContent;

    const { doc, sendInit } = bootWithInit();
    for (const phase of ['idle', 'armed', 'playing', 'broadcasting', 'live']) {
      sendInit(payloadFor(phase, visualMode));
      hints[phase] = doc.getElementById('transport-mode-hint').textContent;
    }
    return hints;
  }

  it("visual-radio hints name the DJ + video pipeline", () => {
    expect(hintsFor('visual-radio')).toEqual({
      idle: 'Stopped. Press PLAY to start, or ARM to prepare.',
      arming: 'Arming: warming up DJ + video pipeline...',
      armed: 'Armed. Press PLAY to go live (~2s), or BROADCAST for RTMP first.',
      playing: 'Preview: DJ music + shuffled videos. Press BROADCAST to go live.',
      broadcasting: 'On air: poster on RTMP. Press PLAY for content (~2s).',
      live: 'Live: DJ music + shuffled videos, broadcasting to RTMP.',
    });
  });

  it('video-playlist hints name the video pipeline', () => {
    expect(hintsFor('video-playlist')).toEqual({
      idle: 'Stopped. Press PLAY to start, or ARM to prepare.',
      arming: 'Arming: warming up video pipeline...',
      armed: 'Armed. Press PLAY to go live (~2s), or BROADCAST for RTMP first.',
      playing: 'Preview: videos with own audio. Press BROADCAST to go live.',
      broadcasting: 'On air: poster on RTMP. Press PLAY for content (~2s).',
      live: 'Live: videos with own audio, broadcasting to RTMP.',
    });
  });

  it('live hints name OBS and the AFK fallback', () => {
    expect(hintsFor('live')).toEqual({
      idle: 'Stopped. OBS/mic stream with AFK fallback.',
      arming: 'Arming: warming up pipeline...',
      armed: 'Armed. Press PLAY to go live. OBS connects to RTMP ingest.',
      playing: 'Preview: waiting for OBS or AFK fallback.',
      broadcasting: 'On air: waiting for OBS. AFK fallback active.',
      live: 'Live: OBS streaming. AFK fallback on disconnect.',
    });
  });

  it('a visual mode with no MODE_HINTS row clears the hint to empty string', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('live', 'visual-radio'));
    expect(doc.getElementById('transport-mode-hint').textContent).not.toBe('');
    // SYNTHETIC payload: 'browser-mic' is a real uiSubMode but not a server
    // visualMode — VALID_MODES can never send it, so this reaches the
    // defensive `hints[s.visualMode] || ''` arm that no live server produces.
    sendInit(payloadFor('live', 'browser-mic'));
    expect(doc.getElementById('transport-mode-hint').textContent).toBe('');
  });
});

describe('queue chrome and the skip/clear handler swap', () => {
  // updateBroadcastUI's mode-aware queue block (broadcast.js).

  it('music mode labels the queue for tracks', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('playing', 'visual-radio'));
    expect(queueChrome(doc)).toEqual({
      panelTitle: 'Queue',
      selectorTitle: 'Add to Queue',
      searchPlaceholder: 'Search tracks...',
    });
  });

  it('video mode labels the queue for videos', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('playing', 'video-playlist'));
    expect(queueChrome(doc)).toEqual({
      panelTitle: 'Video Queue',
      selectorTitle: 'Add Video',
      searchPlaceholder: 'Search videos...',
    });
  });

  it('only video-playlist counts as video mode — the OBS mode keeps the track queue', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('playing', 'live'));
    expect(queueChrome(doc).panelTitle).toBe('Queue');
  });

  it('music mode: SKIP and CLEAR hit the track queue endpoints', async () => {
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.reset();

    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);
    expect(queueCalls(h.calls)).toEqual(['POST /api/queue/skip', 'POST /api/queue/clear']);
  });

  it('video mode: SKIP and CLEAR hit the video queue endpoints', async () => {
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'video-playlist'));
    h.reset();

    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);
    expect(queueCalls(h.calls)).toEqual([
      'POST /api/video-queue/skip',
      'POST /api/video-queue/clear',
    ]);
  });

  it('music mode SKIP defers the queue and history reloads on success', async () => {
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.reset();

    h.skipBtn.click();
    await flush(20);
    // The repaint copy's success branch schedules loadQueue at 1s and
    // FRTrackHistory.loadTrackHistory at 2s. The capture spy swallows both, so
    // the reload requests are absent from the traffic — only the skip POST ran.
    expect(h.delays).toEqual([1000, 2000]);
    expect(queueTraffic(h.calls)).toEqual(['POST /api/queue/skip']);
  });

  it('music mode CLEAR reloads the queue synchronously on success', async () => {
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.reset();

    h.clearBtn.click();
    await flush(20);
    // The repaint copy's success branch calls loadQueue() directly, so the
    // reload GET lands with no timer involved.
    expect(h.delays).toEqual([]);
    expect(queueTraffic(h.calls)).toEqual(['POST /api/queue/clear', 'GET /api/queue']);
  });

  it('video mode SKIP defers only the video queue reload, and CLEAR reloads it directly', async () => {
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'video-playlist'));
    h.reset();

    h.skipBtn.click();
    await flush(20);
    // skipVideo has no track-history reload, so it schedules one timer, not two.
    expect(h.delays).toEqual([1000]);
    expect(queueTraffic(h.calls)).toEqual(['POST /api/video-queue/skip']);

    h.reset();
    h.clearBtn.click();
    await flush(20);
    expect(h.delays).toEqual([]);
    expect(queueTraffic(h.calls)).toEqual([
      'POST /api/video-queue/clear',
      'GET /api/video-queue',
    ]);
  });

  it('a failed skip or clear reloads nothing and reports the reason', async () => {
    // CHANGED IN THE TRACK-CLOSE HOTFIX. This used to assert that a rejected
    // action produced "the POST and nothing else" — including no timers, which
    // was true only because the failure was swallowed in silence. The reload
    // contract is unchanged and still pinned: no GET, and none of the 1000ms /
    // 2000ms reload timers. What is new is the 5000ms error-banner auto-hide,
    // one per failed action, which is the only reason a user learns the skip
    // did not happen.
    const h = bootQueueHarness([
      routeExact('POST', '/api/queue/skip', { ok: false, error: 'liquidsoap unavailable' }),
      routeExact('POST', '/api/queue/clear', { ok: false }),
    ]);
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.reset();

    h.skipBtn.click();
    await flush(20);
    const banner = h.doc.getElementById('error-banner');
    expect(banner.classList.contains('visible')).toBe(true);
    expect(banner.textContent).toBe('Skip failed: liquidsoap unavailable');

    h.clearBtn.click();
    await flush(20);
    // No error field on the clear response — same 'unknown' fallback the add
    // twins use.
    expect(banner.textContent).toBe('Clear queue failed: unknown');

    // Banner auto-hides only; no reload timers, no reload requests.
    expect(h.delays).toEqual([5000, 5000]);
    expect(queueTraffic(h.calls)).toEqual(['POST /api/queue/skip', 'POST /api/queue/clear']);
  });

  it('a failed VIDEO skip or clear reports too', async () => {
    // ADDED IN THE TRACK-CLOSE HOTFIX. The video twins were silent on !ok in
    // exactly the same way; both modes now surface it.
    const h = bootQueueHarness([
      routeExact('POST', '/api/video-queue/skip', { ok: false, error: 'no clip' }),
      routeExact('POST', '/api/video-queue/clear', { ok: false }),
    ]);
    h.sendInit(payloadFor('playing', 'video-playlist'));
    h.reset();

    h.skipBtn.click();
    await flush(20);
    const banner = h.doc.getElementById('error-banner');
    expect(banner.textContent).toBe('Video skip failed: no clip');

    h.clearBtn.click();
    await flush(20);
    expect(banner.textContent).toBe('Clear video queue failed: unknown');

    expect(h.delays).toEqual([5000, 5000]);
    expect(queueTraffic(h.calls)).toEqual([
      'POST /api/video-queue/skip',
      'POST /api/video-queue/clear',
    ]);
  });

  it('switching video mode back to music restores the track queue endpoints and chrome', async () => {
    const h = bootQueueHarness();

    h.sendInit(payloadFor('playing', 'video-playlist'));
    h.reset();
    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);
    const videoTraffic = queueCalls(h.calls);
    expect(queueChrome(h.doc)).toEqual({
      panelTitle: 'Video Queue',
      selectorTitle: 'Add Video',
      searchPlaceholder: 'Search videos...',
    });

    h.reset();
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);

    expect(videoTraffic).toEqual(['POST /api/video-queue/skip', 'POST /api/video-queue/clear']);
    expect(queueCalls(h.calls)).toEqual(['POST /api/queue/skip', 'POST /api/queue/clear']);
    // The round trip is what pins the music-mode else arms:
    // on a fresh boot these three strings equal the markup defaults, so only a
    // repaint that has already written the video labels can prove they are
    // written back.
    expect(queueChrome(h.doc)).toEqual({
      panelTitle: 'Queue',
      selectorTitle: 'Add to Queue',
      searchPlaceholder: 'Search tracks...',
    });
  });

  it('STOP clears the transport readout through the module that owns it', async () => {
    // broadcast.js used to write these six nodes itself, while nowplaying.js
    // resolved and repainted the same nodes — two modules assigning one set of
    // elements. The writes now go through FRNowPlaying.resetTransportDom; this
    // pins the observable result so the delegation cannot quietly become a
    // no-op.
    const h = bootQueueHarness([
      routeExact('POST', '/api/stream/control', { ok: true }),
      routeExact('POST', '/api/stream/mode', { ok: true }),
      routeExact('POST', '/api/broadcast', { ok: true }),
    ]);
    h.sendInit(payloadFor('live', 'visual-radio'));

    // Seed the readout as a playing stream leaves it.
    const doc = h.doc;
    doc.getElementById('studio-audio-track').textContent = 'track.mp3';
    doc.getElementById('studio-bpm').textContent = '128';
    doc.getElementById('transport-bar-fill').style.width = '42%';
    doc.getElementById('transport-elapsed').textContent = '1:23';
    doc.getElementById('transport-duration').textContent = '3:45';
    doc.getElementById('transport-cue').style.display = 'block';

    doc.getElementById('btn-stop').click();
    await flush(20);

    expect(doc.getElementById('studio-audio-track').textContent).toBe('--');
    expect(doc.getElementById('studio-bpm').textContent).toBe('');
    expect(doc.getElementById('transport-bar-fill').style.width).toBe('0%');
    expect(doc.getElementById('transport-elapsed').textContent).toBe('0:00');
    expect(doc.getElementById('transport-duration').textContent).toBe('0:00');
    expect(doc.getElementById('transport-cue').style.display).toBe('none');
  });

  it('the one bound handler dispatches to the MUSIC endpoints in music mode', async () => {
    // Was an equivalence pin across two byte-identical copies of these bodies
    // (queue.js's boot binding and updateBroadcastUI's repaint copy). There is
    // one copy now, so what is worth pinning is the dispatch and the deferred
    // reloads it schedules.
    const h = bootQueueHarness();

    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);
    const bootTraffic = queueTraffic(h.calls);
    const bootDelays = h.delays.slice();

    expect(bootTraffic).toEqual([
      'POST /api/queue/skip',
      'POST /api/queue/clear',
      'GET /api/queue',
    ]);
    expect(bootDelays).toEqual([1000, 2000]);

    // A repaint does not change any of that — it no longer touches the handlers.
    h.reset();
    h.sendInit(payloadFor('playing', 'visual-radio'));
    h.reset();
    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);

    expect(queueTraffic(h.calls)).toEqual(bootTraffic);
    expect(h.delays).toEqual(bootDelays);
  });

  it('the SAME bound handler dispatches to the VIDEO endpoints in video mode', async () => {
    // The dispatch is read from the broadcast state at click time, so switching
    // the mode switches the endpoints without rebinding anything.
    const h = bootQueueHarness();
    h.sendInit(payloadFor('playing', 'video-playlist'));
    h.reset();

    h.skipBtn.click();
    h.clearBtn.click();
    await flush(20);

    expect(queueTraffic(h.calls)).toEqual([
      'POST /api/video-queue/skip',
      'POST /api/video-queue/clear',
      'GET /api/video-queue',
    ]);
    // Video skip defers its reload the same way the music path does.
    expect(h.delays).toEqual([1000]);
  });

  it('music mode does NOT reinstall the handlers on repaint', () => {
    // Inverted deliberately. This used to pin the duplication: every music-mode
    // repaint replaced both handlers with freshly allocated closures. queue.js
    // is the single owner now, so the identity bound at boot must survive any
    // number of repaints.
    const { doc, sendInit } = bootWithInit();
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');
    const bootSkip = skipBtn.onclick;
    const bootClear = clearBtn.onclick;

    sendInit(payloadFor('playing', 'visual-radio'));
    sendInit(payloadFor('live', 'visual-radio'));

    expect(skipBtn.onclick).toBe(bootSkip);
    expect(clearBtn.onclick).toBe(bootClear);
  });

  it('video mode uses that same boot-bound handler, across repaints', () => {
    // Previously the video branch assigned FRQueue.skipVideo/clearVideoQueue
    // directly, so the two modes had different handler identities. One owner
    // now: the identity is the same in both modes and across repaints, and only
    // what it dispatches to changes.
    const { doc, sendInit } = bootWithInit();
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');
    const bootSkip = skipBtn.onclick;
    const bootClear = clearBtn.onclick;

    sendInit(payloadFor('playing', 'video-playlist'));
    expect(skipBtn.onclick).toBe(bootSkip);
    sendInit(payloadFor('live', 'video-playlist'));

    expect(skipBtn.onclick).toBe(bootSkip);
    expect(clearBtn.onclick).toBe(bootClear);
  });
});

describe('deriveUiMode mapping and the mode-card class state it drives', () => {
  // deriveUiMode (broadcast.js -> FRUtils.deriveUiMode) feeding updateModeUI (broadcast.js).

  it("visualMode 'visual-radio' paints the radio card and its Visual Radio pill", () => {
    const { win, doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'visual-radio'));
    expect(modeClasses(doc)).toEqual({
      layout: ['mode-radio', 'studio-layout', 'submode-visual-radio'],
      radioCardActive: true,
      radioCardLocked: false,
      activePills: ['visual-radio'],
      liveModeBarDisplay: null,
    });
    const state = win.__appDrift.getBroadcastState();
    expect([state.uiMode, state.uiSubMode]).toEqual(['radio', 'visual-radio']);
  });

  it("visualMode 'video-playlist' keeps the radio card but moves the active pill", () => {
    const { win, doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'video-playlist'));
    expect(modeClasses(doc)).toEqual({
      layout: ['mode-radio', 'studio-layout', 'submode-video-playlist'],
      radioCardActive: true,
      radioCardLocked: false,
      activePills: ['video-playlist'],
      liveModeBarDisplay: null,
    });
    const state = win.__appDrift.getBroadcastState();
    expect([state.uiMode, state.uiSubMode]).toEqual(['radio', 'video-playlist']);
  });

  it("visualMode 'live' is the only one mapping to takeover/obs — and leaves no card highlighted", () => {
    const { win, doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'live'));
    // Phase 1 ships only the radio mode-card (the takeover card is commented out
    // in index.html), so takeover deselects the radio card and highlights none.
    // The sub-pills belong to the radio card, which is no longer the active card,
    // so their highlight is left exactly as the previous paint left it — here the
    // 'active' the markup ships with.
    expect(modeClasses(doc)).toEqual({
      layout: ['mode-takeover', 'studio-layout', 'submode-obs'],
      radioCardActive: false,
      radioCardLocked: false,
      activePills: ['visual-radio'],
      liveModeBarDisplay: null,
    });
    const state = win.__appDrift.getBroadcastState();
    expect([state.uiMode, state.uiSubMode]).toEqual(['takeover', 'obs']);
  });

  it('entering takeover leaves whichever sub-pill was highlighted before it', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'video-playlist'));
    expect(modeClasses(doc).activePills).toEqual(['video-playlist']);
    sendInit(payloadFor('idle', 'live'));
    expect(modeClasses(doc).activePills).toEqual(['video-playlist']);
  });

  it('any other visualMode falls through to radio with the raw value as sub-mode', () => {
    const { win, doc, sendInit } = bootWithInit();
    // SYNTHETIC payload, as in the MODE_HINTS fallback pin: 'browser-mic' is a
    // real uiSubMode but never a server visualMode, so this exercises the
    // defensive fallback arm rather than a reachable production state.
    sendInit(payloadFor('idle', 'browser-mic'));
    expect(modeClasses(doc)).toEqual({
      layout: ['mode-radio', 'studio-layout', 'submode-browser-mic'],
      radioCardActive: true,
      radioCardLocked: false,
      activePills: [],
      liveModeBarDisplay: null,
    });
    const state = win.__appDrift.getBroadcastState();
    expect([state.uiMode, state.uiSubMode]).toEqual(['radio', 'browser-mic']);
  });

  // The lock rule is `locked && !card.classList.contains('active')` in updateModeUI.
  it('going on air locks every mode card except the active one', () => {
    const { doc, sendInit } = bootWithInit();
    // Radio card active and on air: the active card is exempt from the lock.
    sendInit(payloadFor('live', 'visual-radio'));
    expect(modeClasses(doc).radioCardActive).toBe(true);
    expect(modeClasses(doc).radioCardLocked).toBe(false);

    // Takeover on air: the radio card is no longer active, so it gets locked.
    sendInit(payloadFor('live', 'live'));
    expect(modeClasses(doc).radioCardActive).toBe(false);
    expect(modeClasses(doc).radioCardLocked).toBe(true);
  });

  it('returning to standby clears the card lock even while still in takeover', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('live', 'live'));
    expect(modeClasses(doc).radioCardLocked).toBe(true);

    // Only streamMode drives the lock — the ui mode is still takeover here.
    sendInit(payloadFor('idle', 'live'));
    expect(modeClasses(doc)).toEqual({
      layout: ['mode-takeover', 'studio-layout', 'submode-obs'],
      radioCardActive: false,
      radioCardLocked: false,
      activePills: ['visual-radio'],
      liveModeBarDisplay: null,
    });
  });

  it('the Live Mode Bar write stays inert while its element is absent', () => {
    // The guarded write is in updateModeUI. Takeover is the mode that would reveal
    // the bar, but Phase 1 comments the element out of index.html, so the null
    // guard swallows the write and nothing throws. Pinned as-is; a Phase 3
    // markup change should fail here.
    const { doc, sendInit } = bootWithInit();
    expect(doc.getElementById('live-mode-bar')).toBe(null);
    sendInit(payloadFor('live', 'live'));
    expect(modeClasses(doc).liveModeBarDisplay).toBe(null);
    sendInit(payloadFor('live', 'visual-radio'));
    expect(modeClasses(doc).liveModeBarDisplay).toBe(null);
  });

  it('leaving takeover for radio clears the takeover classes rather than stacking them', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'live'));
    sendInit(payloadFor('idle', 'visual-radio'));
    expect(modeClasses(doc).layout).toEqual(['mode-radio', 'studio-layout', 'submode-visual-radio']);
  });
});

describe('broadcast repaint via the /api/status poll consumer', () => {
  // loadBroadcastState (broadcast.js), reached through the real login flow.

  it('logging in repaints the transport row from the polled state', async () => {
    const { win, doc } = bootWithInit();
    const calls = await loginAndPoll(win, doc, payloadFor('armed', 'video-playlist'));

    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/status')).toBe(true);
    expect(transportSnapshot(doc)).toEqual({
      tagText: 'ARMED',
      tagClass: 'mode-tag ready',
      armDisabled: true,
      armDisplay: 'none',
      playDisabled: false,
      stopDisabled: false,
      broadcastDisabled: false,
      broadcastText: 'BROADCAST',
      skipDisabled: true,
    });
    expect(queueChrome(doc).panelTitle).toBe('Video Queue');
  });

  it('the polled state drives deriveUiMode exactly like the init frame does', async () => {
    const { win, doc } = bootWithInit();
    await loginAndPoll(win, doc, payloadFor('live', 'live'));

    expect(modeClasses(doc)).toEqual({
      layout: ['mode-takeover', 'studio-layout', 'submode-obs'],
      radioCardActive: false,
      // streamMode is 'live' here, so the deselected radio card is also locked.
      radioCardLocked: true,
      activePills: ['visual-radio'],
      liveModeBarDisplay: null,
    });
    expect(doc.getElementById('transport-mode-hint').textContent)
      .toBe('Live: OBS streaming. AFK fallback on disconnect.');
  });

  it('both consumers produce the same DOM for the same server state', async () => {
    const state = payloadFor('broadcasting', 'video-playlist');

    const viaInit = bootWithInit();
    viaInit.sendInit(state);

    const viaPoll = bootWithInit();
    await loginAndPoll(viaPoll.win, viaPoll.doc, state);

    expect(transportSnapshot(viaPoll.doc)).toEqual(transportSnapshot(viaInit.doc));
    expect(queueChrome(viaPoll.doc)).toEqual(queueChrome(viaInit.doc));
    expect(modeClasses(viaPoll.doc)).toEqual(modeClasses(viaInit.doc));
    expect(viaPoll.doc.getElementById('transport-mode-hint').textContent)
      .toBe(viaInit.doc.getElementById('transport-mode-hint').textContent);
  });

  it('the polled state installs the video-mode skip handler', async () => {
    const { win, doc } = bootWithInit();
    const calls = await loginAndPoll(win, doc, payloadFor('playing', 'video-playlist'));
    calls.length = 0;

    doc.getElementById('skip-btn').click();
    doc.getElementById('clear-queue-btn').click();
    expect(queueCalls(calls)).toEqual(['POST /api/video-queue/skip', 'POST /api/video-queue/clear']);
  });
});

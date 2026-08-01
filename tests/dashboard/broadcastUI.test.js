/**
 * tests/dashboard/broadcastUI.test.js
 *
 * Characterization pins for the BROADCAST REPAINT CONTRACT currently living
 * inside the app.js IIFE: the pair deriveUiMode() (app.js:1380-1384, delegating
 * to FRUtils.deriveUiMode at utils.js:153-158) + updateBroadcastUI()
 * (app.js:1249-1314, reading the phase from getBroadcastPhase() at app.js:1210
 * -> FRUtils.getBroadcastPhase at utils.js:133-142, and the hint table
 * MODE_HINTS at app.js:1216-1247). These pin the AS-IS observable contract
 * BEFORE the region is extracted into a module; they must stay green after the
 * extraction to prove zero behaviour change.
 *
 * CONSUMER-SHAPED. The pair is never called by a test directly. Both real
 * consumers do the same two calls back to back and are driven end to end here:
 *
 *   1. The WebSocket 'init' frame — handleMessage case 'init' (app.js:592-619,
 *      the pair at 609-610). Driven by boot-time socket.onmessage({ data }) with
 *      a real server-shaped JSON payload. onmessage is a plain instance property
 *      assigned in connectWs (app.js:577), and the appBoot WebSocket stub
 *      (appBoot.js:63-68) never fires anything on its own, so the test supplies
 *      the frame.
 *
 *   2. The /api/status poll — loadBroadcastState (app.js:1919-1948, the pair at
 *      1934-1935). Reached WITHOUT any new app.js hook: FRAuth.init's onLogin
 *      callback (app.js:502-508) calls loadBroadcastState(), and onLogin fires
 *      from doLogin (auth.js:111-134). So the test types a token into the real
 *      #login-token input and clicks the real #login-btn; the fetch stub answers
 *      /api/auth/verify and then /api/status. Boot's own loadBroadcastState()
 *      call (app.js:1951) is left pending forever by appBoot's never-resolving
 *      default fetch, and the 15s setInterval (app.js:1952) is unreachable in a
 *      test, so the login flow is the only usable entry into this consumer.
 *
 * ASSERTIONS are observable effects only: transport button text/disabled/display,
 * the mode-tag element, the hint element, the queue chrome, the .studio-layout /
 * .mode-card class state written by updateModeUI (app.js:1387-1433), and which
 * endpoint each swapped skip/clear onclick actually calls through the fetch stub.
 * window.__appDrift.getBroadcastState() is read only as a SECONDARY confirmation
 * next to a DOM assertion, never as the primary pin.
 *
 * REACHING THE 'arming' PHASE: `arming` is a client-only flag — no server payload
 * sets it (getBroadcastPhase checks state.arming first, utils.js:134). Its sole
 * writer on the way up is the real ARM button handler (app.js:1484-1489), so the
 * arming pins click #btn-arm and then drive an 'init' frame through consumer 1.
 * The click has to happen on a freshly booted window: updateBroadcastUI disables
 * ARM in every phase but idle, and a disabled button runs no activation
 * behaviour. With appBoot's never-resolving default fetch the ARM API chain stays
 * pending, so the flag holds for the duration of the test. btnArm.onclick calls
 * azInit()
 * BEFORE setting the flag (app.js:1488), and azInit's own error path calls
 * azAudioCtx.close() (app.js:3025) which the appBoot AudioContext stub does not
 * implement — that secondary throw would escape the handler and abort ARM. The
 * arming helper therefore widens the stub with a close() returning a promise.
 * This is a browser-API completion local to this file; appBoot.js is untouched.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush } from './appBoot.js';

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
 * Everything updateModeUI (app.js:1387-1433) writes, in one object: the layout
 * mode/sub-mode classes, the card highlight, the sub-pill highlight, the
 * on-air card lock (app.js:1418-1421) and the Live Mode Bar (app.js:1425).
 *
 * liveModeBarDisplay is null whenever #live-mode-bar is absent from the DOM.
 * Phase 1 ships that element inside a Phase 3 HTML comment, so liveModeSettings
 * (app.js:1190) resolves to null and the `if (liveModeSettings)` guard makes the
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

/** Queue endpoints the fetch stub saw, in call order (ignores boot data loads). */
function queueCalls(calls) {
  return calls
    .filter((c) => c.url.indexOf('queue/') !== -1)
    .map((c) => c.method + ' ' + c.url);
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

describe('broadcast repaint via the WS init consumer (app.js:592-619 -> 1249-1314)', () => {
  it('idle: ARM is the only enabled control and stays visible', () => {
    const { doc, sendInit } = bootWithInit();
    sendInit(payloadFor('idle', 'visual-radio'));
    // playDisabled: true here deliberately contradicts both the button-state
    // table at app.js:1260-1265 (which documents the idle row as PLAY:on) and
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

describe('MODE_HINTS text per phase and visual mode (app.js:1216-1247, 1312-1313)', () => {
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
    // 'browser-mic' is a real uiSubMode but has no MODE_HINTS entry.
    sendInit(payloadFor('live', 'browser-mic'));
    expect(doc.getElementById('transport-mode-hint').textContent).toBe('');
  });
});

describe('queue chrome and the skip/clear handler swap (app.js:1283-1309)', () => {
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

  it('music mode: SKIP and CLEAR hit the track queue endpoints', () => {
    const { win, doc, sendInit } = bootWithInit();
    const { fetch, calls } = makeFetchStub([]);
    win.fetch = fetch;
    sendInit(payloadFor('playing', 'visual-radio'));

    doc.getElementById('skip-btn').click();
    doc.getElementById('clear-queue-btn').click();
    expect(queueCalls(calls)).toEqual(['POST /api/queue/skip', 'POST /api/queue/clear']);
  });

  it('video mode: SKIP and CLEAR hit the video queue endpoints', () => {
    const { win, doc, sendInit } = bootWithInit();
    const { fetch, calls } = makeFetchStub([]);
    win.fetch = fetch;
    sendInit(payloadFor('playing', 'video-playlist'));

    doc.getElementById('skip-btn').click();
    doc.getElementById('clear-queue-btn').click();
    expect(queueCalls(calls)).toEqual(['POST /api/video-queue/skip', 'POST /api/video-queue/clear']);
  });

  it('switching video mode back to music restores the track queue endpoints', () => {
    const { win, doc, sendInit } = bootWithInit();
    const { fetch, calls } = makeFetchStub([]);
    win.fetch = fetch;
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');

    sendInit(payloadFor('playing', 'video-playlist'));
    skipBtn.click();
    clearBtn.click();
    sendInit(payloadFor('playing', 'visual-radio'));
    skipBtn.click();
    clearBtn.click();

    expect(queueCalls(calls)).toEqual([
      'POST /api/video-queue/skip',
      'POST /api/video-queue/clear',
      'POST /api/queue/skip',
      'POST /api/queue/clear',
    ]);
  });

  it('the boot-bound handlers and the music-mode copies call the same endpoints', () => {
    // updateBroadcastUI's non-video branch re-declares handler bodies already
    // bound at boot (app.js:837-860). Both copies must stay interchangeable.
    const { win, doc, sendInit } = bootWithInit();
    const { fetch, calls } = makeFetchStub([]);
    win.fetch = fetch;
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');

    skipBtn.click();
    clearBtn.click();
    const bootEndpoints = queueCalls(calls);
    calls.length = 0;

    sendInit(payloadFor('playing', 'visual-radio'));
    skipBtn.click();
    clearBtn.click();

    expect(bootEndpoints).toEqual(['POST /api/queue/skip', 'POST /api/queue/clear']);
    expect(queueCalls(calls)).toEqual(bootEndpoints);
  });

  it('music mode installs a FRESH handler pair on every repaint', () => {
    const { doc, sendInit } = bootWithInit();
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');
    const bootSkip = skipBtn.onclick;

    sendInit(payloadFor('playing', 'visual-radio'));
    const firstSkip = skipBtn.onclick;
    const firstClear = clearBtn.onclick;
    sendInit(payloadFor('live', 'visual-radio'));

    expect(firstSkip).not.toBe(bootSkip);
    expect(skipBtn.onclick).not.toBe(firstSkip);
    expect(clearBtn.onclick).not.toBe(firstClear);
  });

  it('video mode reuses the same named handlers across repaints', () => {
    const { doc, sendInit } = bootWithInit();
    const skipBtn = doc.getElementById('skip-btn');
    const clearBtn = doc.getElementById('clear-queue-btn');

    sendInit(payloadFor('playing', 'video-playlist'));
    const firstSkip = skipBtn.onclick;
    const firstClear = clearBtn.onclick;
    sendInit(payloadFor('live', 'video-playlist'));

    expect(skipBtn.onclick).toBe(firstSkip);
    expect(clearBtn.onclick).toBe(firstClear);
  });
});

describe('deriveUiMode mapping surfaced through the repaint (utils.js:153-158)', () => {
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

  it('going on air locks every mode card except the active one (app.js:1418-1421)', () => {
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

  it('the Live Mode Bar write stays inert while its element is absent (app.js:1425)', () => {
    // Takeover is the mode that would reveal the bar, but Phase 1 comments the
    // element out of index.html, so updateModeUI's null guard swallows the write
    // and nothing throws. Pinned as-is; a Phase 3 markup change should fail here.
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

describe('broadcast repaint via the /api/status poll consumer (app.js:1919-1948)', () => {
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

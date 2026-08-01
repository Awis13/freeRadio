/**
 * tests/dashboard/queueUI.test.js
 *
 * Characterization pins for the queue and track-selector surface: loadQueue /
 * renderQueue / addToQueue, their video-queue twins, loadActiveQueue,
 * renderTrackSelector and the queue-search filter. Taken while that surface was
 * still in the app.js IIFE and kept green through its extraction into queue.js.
 *
 * These pin AS-IS observable behaviour and fix nothing.
 *
 * NOT DUPLICATED HERE. broadcastUI.test.js already pins which endpoint the skip
 * and clear buttons hit, the handler swap between music and video mode, and the
 * deferred reload timers. This file pins what those reloads then RENDER, plus
 * the selector and filter, which nothing covered.
 *
 * CONSUMER-SHAPED. renderQueue has no post-boot entry point of its own — the
 * boot loadQueue() is left pending by appBoot's never-resolving fetch and the 5s
 * loadActiveQueue interval is unreachable in a test. So the queue list is driven
 * through the real CLEAR button, whose success branch calls loadQueue(); the
 * fetch stub then answers /api/queue and the render is asserted. The selector is
 * driven through the WS 'init' frame, which calls FRFileMgmt.loadFileList('music'),
 * whose success branch calls back into FRQueue.renderTrackSelector.
 *
 * VIDEO-MODE SELECTOR IS NOT PINNED. renderTrackSelector's video branch reads
 * processedVisualFiles, which is only ever populated by loadProcessedVisuals()
 * at boot and on a 30s interval — neither reachable from a test — so the video
 * selector renders zero items for harness reasons rather than app reasons.
 * Pinning that would pin the harness, not the contract. The video ADD path is
 * covered indirectly by the existing skip/clear handler-swap pins.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot and rethrow a load error so a boot failure fails loudly. */
function boot() {
  const { win, doc, loadError } = bootWindow();
  if (loadError) throw loadError;
  return {
    win,
    doc,
    send: (msg) => win.__appWs.getWs().onmessage({ data: JSON.stringify(msg) }),
  };
}

/** Server-shaped 'init' payload (same builder shape as the broadcast pins). */
function initState(streamMode, broadcast, visualMode, extra) {
  return Object.assign({
    streamControl: { streaming: streamMode !== 'standby', broadcast: broadcast },
    streamMode: { mode: streamMode, standbyVisual: null },
    visualMode: { mode: visualMode || 'visual-radio' },
  }, extra || {});
}

/** The queue list as { num, name, title } rows, or the empty-state text. */
function queueRows(doc) {
  const list = doc.getElementById('queue-list');
  const empty = list.querySelector('.queue-empty');
  if (empty) return { empty: empty.textContent };
  return {
    rows: Array.from(list.querySelectorAll('.queue-item')).map((item) => ({
      num: item.querySelector('.queue-num').textContent,
      name: item.querySelector('.queue-name').textContent,
      title: item.querySelector('.queue-name').title,
    })),
  };
}

/** The track selector as { name, bpm } rows. */
function selectorRows(doc) {
  return Array.from(doc.getElementById('track-selector').querySelectorAll('.selector-item'))
    .map((item) => {
      const bpm = item.querySelector('.selector-bpm');
      return { name: item.querySelector('.selector-name').textContent, bpm: bpm ? bpm.textContent : null };
    });
}

/** Drive the CLEAR button, whose success branch reloads and re-renders the queue. */
async function reloadQueueViaClear(win, doc, items) {
  const { fetch, calls } = makeFetchStub([
    routeExact('POST', '/api/queue/clear', { ok: true }),
    routeExact('GET', '/api/queue', items),
  ]);
  win.fetch = fetch;
  doc.getElementById('clear-queue-btn').click();
  await flush(20);
  return calls;
}

describe('queue list rendering', () => {
  it('renders a numbered row per entry, cleaning the display name', async () => {
    const { win, doc } = boot();
    await reloadQueueViaClear(win, doc, ['music/Artist - One.mp3', 'music/Two.flac']);

    // The full path stays in the title attribute while the visible name is
    // cleanTrackName'd (directory and extension stripped).
    expect(queueRows(doc)).toEqual({
      rows: [
        { num: '1.', name: 'Artist - One', title: 'music/Artist - One.mp3' },
        { num: '2.', name: 'Two', title: 'music/Two.flac' },
      ],
    });
  });

  it('renders the empty state for an empty queue', async () => {
    const { win, doc } = boot();
    // #queue-list ships the empty-state div in the markup, so render real rows
    // first — otherwise this would pass with renderQueue's empty branch deleted.
    await reloadQueueViaClear(win, doc, ['a.mp3']);
    expect(queueRows(doc).rows).toHaveLength(1);

    await reloadQueueViaClear(win, doc, []);

    expect(queueRows(doc)).toEqual({ empty: 'Queue empty — random mode' });
  });

  it('replaces the previous render rather than appending', async () => {
    const { win, doc } = boot();
    await reloadQueueViaClear(win, doc, ['a.mp3', 'b.mp3', 'c.mp3']);
    expect(queueRows(doc).rows).toHaveLength(3);

    await reloadQueueViaClear(win, doc, ['d.mp3']);
    expect(queueRows(doc)).toEqual({ rows: [{ num: '1.', name: 'd', title: 'd.mp3' }] });
  });

  it('falls back to the empty state when the queue request fails', async () => {
    const { win, doc } = boot();
    await reloadQueueViaClear(win, doc, ['a.mp3']);
    expect(queueRows(doc).rows).toHaveLength(1);

    // loadQueue's .catch renders an empty list rather than leaving the stale one.
    const { fetch } = makeFetchStub([routeExact('POST', '/api/queue/clear', { ok: true })]);
    win.fetch = function (url, opts) {
      if (String(url) === '/api/queue') return Promise.reject(new Error('network down'));
      return fetch(url, opts);
    };
    doc.getElementById('clear-queue-btn').click();
    await flush(20);

    expect(queueRows(doc)).toEqual({ empty: 'Queue empty — random mode' });
  });

  it('a non-array queue payload also lands in the empty state', async () => {
    const { win, doc } = boot();
    await reloadQueueViaClear(win, doc, ['a.mp3']);

    // renderQueue's guard is `!items || items.length === 0`, which an object
    // passes, so it reaches items.forEach and throws. loadQueue's .catch
    // swallows that and re-renders empty — a malformed response is
    // indistinguishable from an empty queue.
    await reloadQueueViaClear(win, doc, { unexpected: 'shape' });

    expect(queueRows(doc)).toEqual({ empty: 'Queue empty — random mode' });
  });
});

describe('track selector rendering and the add-to-queue path', () => {
  /** Populate the selector through the WS init frame's music-list load. */
  async function bootWithMusic(files, bpm, visualMode) {
    const h = boot();
    const { fetch, calls } = makeFetchStub([
      routeExact('GET', '/api/music', files),
      routeExact('GET', '/api/visuals', []),
      routeExact('POST', '/api/queue/push', { ok: true }),
      routeExact('GET', '/api/queue', []),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, visualMode, { bpm: bpm || {} }) });
    await flush(20);
    calls.length = 0;
    return Object.assign(h, { calls });
  }

  it('renders one row per music file, with a BPM badge only where a BPM is known', async () => {
    const { doc } = await bootWithMusic(
      [{ name: 'Alpha.mp3', size: 1 }, { name: 'Beta.mp3', size: 2 }],
      { 'Alpha.mp3': 128 },
    );
    expect(selectorRows(doc)).toEqual([
      { name: 'Alpha.mp3', bpm: '128 BPM' },
      { name: 'Beta.mp3', bpm: null },
    ]);
  });

  it('rounds the BPM badge', async () => {
    const { doc } = await bootWithMusic([{ name: 'Alpha.mp3' }], { 'Alpha.mp3': 127.6 });
    expect(selectorRows(doc)[0].bpm).toBe('128 BPM');
  });

  it('the add button posts the raw filename as a text/plain body and reloads', async () => {
    const { doc, calls } = await bootWithMusic(
      [{ name: 'Alpha.mp3' }, { name: 'Beta.mp3' }], {},
    );

    doc.getElementById('track-selector').querySelectorAll('.btn-add-queue')[1].click();
    await flush(20);

    expect(calls.map((c) => c.method + ' ' + c.url)).toEqual([
      'POST /api/queue/push',
      'GET /api/queue',
    ]);
    // Each add button closes over its OWN filename, so the second button posts
    // the second name rather than the last one rendered.
    expect(calls[0].body).toBe('Beta.mp3');
    expect(calls[0].url).toBe('/api/queue/push');
  });

  it('a rejected add surfaces the server error and does not reload the queue', async () => {
    const h = boot();
    const { fetch, calls } = makeFetchStub([
      routeExact('GET', '/api/music', [{ name: 'Alpha.mp3' }]),
      routeExact('GET', '/api/visuals', []),
      routeExact('POST', '/api/queue/push', { ok: false, error: 'queue full' }),
      routeExact('GET', '/api/queue', []),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, 'visual-radio', { bpm: {} }) });
    await flush(20);
    calls.length = 0;

    h.doc.getElementById('track-selector').querySelector('.btn-add-queue').click();
    await flush(20);

    const banner = h.doc.getElementById('error-banner');
    expect(banner.textContent).toBe('Queue push failed: queue full');
    expect(banner.classList.contains('visible')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/api/queue/push']);
  });

  it('a rejected VIDEO add reports too, matching its music twin', async () => {
    // CHANGED IN T15-C2. The video push swallowed { ok: false } — the add
    // simply appeared to do nothing — while its music twin has always surfaced
    // it. Driven through the real selector button, the same way the music pins
    // above do, since the video add is reached only from that click.
    // Note the skip/clear pair stays silent on !ok in BOTH modes: that half was
    // already symmetric, so only the add path needed aligning.
    const h = boot();
    const { fetch, calls } = makeFetchStub([
      routeExact('GET', '/api/music', []),
      routeExact('GET', '/api/visuals', []),
      routeExact('GET', '/api/visuals-processed', [{ name: 'clip.mp4', size: 10 }]),
      routeExact('POST', '/api/video-queue/push', { ok: false, error: 'queue full' }),
      routeExact('GET', '/api/video-queue', []),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, 'video-playlist', { bpm: {} }) });
    await flush(20);
    calls.length = 0;

    h.win.FRQueue.addToVideoQueue('clip.mp4');
    await flush(20);

    const banner = h.doc.getElementById('error-banner');
    expect(banner.textContent).toBe('Video queue push failed: queue full');
    expect(banner.classList.contains('visible')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/api/video-queue/push']);
  });

  it('a rejected VIDEO add with no error field reports unknown', async () => {
    const h = boot();
    const { fetch } = makeFetchStub([
      routeExact('GET', '/api/music', []),
      routeExact('GET', '/api/visuals', []),
      routeExact('GET', '/api/visuals-processed', [{ name: 'clip.mp4', size: 10 }]),
      routeExact('POST', '/api/video-queue/push', { ok: false }),
      routeExact('GET', '/api/video-queue', []),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, 'video-playlist', { bpm: {} }) });
    await flush(20);
    h.win.FRQueue.addToVideoQueue('clip.mp4');
    await flush(20);

    expect(h.doc.getElementById('error-banner').textContent).toBe('Video queue push failed: unknown');
  });

  it('a rejected add with no error field reports unknown', async () => {
    const h = boot();
    const { fetch } = makeFetchStub([
      routeExact('GET', '/api/music', [{ name: 'Alpha.mp3' }]),
      routeExact('GET', '/api/visuals', []),
      routeExact('POST', '/api/queue/push', { ok: false }),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, 'visual-radio', { bpm: {} }) });
    await flush(20);

    h.doc.getElementById('track-selector').querySelector('.btn-add-queue').click();
    await flush(20);

    expect(h.doc.getElementById('error-banner').textContent).toBe('Queue push failed: unknown');
  });
});

describe('queue search filter', () => {
  async function bootWithFiles(names) {
    const h = boot();
    const { fetch } = makeFetchStub([
      routeExact('GET', '/api/music', names.map((n) => ({ name: n }))),
      routeExact('GET', '/api/visuals', []),
    ]);
    h.win.fetch = fetch;
    h.send({ type: 'init', data: initState('live', true, 'visual-radio', { bpm: {} }) });
    await flush(20);
    return h;
  }

  /** Type into the real #queue-search input and fire its oninput handler. */
  function search(win, doc, value) {
    const input = doc.getElementById('queue-search');
    input.value = value;
    input.dispatchEvent(new win.Event('input'));
  }

  it('filters on a case-insensitive substring of the filename', async () => {
    const { win, doc } = await bootWithFiles(['Alpha.mp3', 'Beta.mp3', 'GAMMA-alpha.mp3']);
    search(win, doc, 'alp');
    expect(selectorRows(doc).map((r) => r.name)).toEqual(['Alpha.mp3', 'GAMMA-alpha.mp3']);
  });

  it('an empty search restores the full list', async () => {
    const { win, doc } = await bootWithFiles(['Alpha.mp3', 'Beta.mp3']);
    search(win, doc, 'beta');
    expect(selectorRows(doc)).toHaveLength(1);
    search(win, doc, '');
    expect(selectorRows(doc).map((r) => r.name)).toEqual(['Alpha.mp3', 'Beta.mp3']);
  });

  it('a search matching nothing empties the selector without an empty-state row', async () => {
    const { win, doc } = await bootWithFiles(['Alpha.mp3', 'Beta.mp3']);
    search(win, doc, 'zzz');
    // Unlike the queue list, the selector has no empty state — it just renders
    // nothing at all.
    expect(selectorRows(doc)).toEqual([]);
    expect(doc.getElementById('track-selector').innerHTML).toBe('');
  });
});

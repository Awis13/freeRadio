const fs = require('fs');
const http = require('http');
const path = require('path');
const liqClient = require('./liqClient');
const s3 = require('./s3');
const cacheManager = require('./cacheManager');
const streamControl = require('./streamControl');

let _bootAborted = false;

function setBootAborted(val) { _bootAborted = val; }
function isBootAborted() { return _bootAborted; }

function probeStatus() {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: 'dj', port: 7000, path: '/playback/status',
      timeout: 3000, agent
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        agent.destroy();
        try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
      });
    });
    req.on('error', (e) => { agent.destroy(); reject(e); });
    req.on('timeout', () => { req.destroy(); agent.destroy(); reject(new Error('timeout')); });
  });
}

async function boot({ musicDir, visualsDir }) {
  _bootAborted = false;

  // Phase 0: S3 boot sync
  if (s3.S3_ENABLED) {
    const syncStart = Date.now();
    try {
      await s3.syncDir('music/processed/', path.join(musicDir, 'processed'));
      for (const meta of ['.analysis_map', '.bpm_map']) {
        try {
          await s3.ensureCached(`music/${meta}`, path.join(musicDir, meta));
        } catch (e) {
          console.error(`[s3] boot sync metadata ${meta} failed: ${e.message}`);
        }
      }
      const { getActiveProfile } = require('./visualProfile');
      const active = getActiveProfile();
      if (active && active.videos) {
        await cacheManager.prefetchVideos(active.videos, visualsDir);
      }
      const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
      console.log(`[s3] boot sync completed in ${elapsed}s`);
    } catch (e) {
      console.error(`[s3] boot sync failed: ${e.message}`);
    }
  }

  // Auto-restore: wait for Liquidsoap, then set mode
  const MAX_RETRIES = 30;
  const RETRY_INTERVAL = 2000;
  const start = Date.now();

  await new Promise(r => setTimeout(r, 1000));
  let probeResult = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_bootAborted) { console.log('[boot] Aborted by user'); return; }
    try {
      probeResult = await probeStatus();
      break;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`[boot] Liquidsoap not ready (${attempt}/${MAX_RETRIES}): ${e.message}`);
        await new Promise(r => setTimeout(r, RETRY_INTERVAL));
      } else {
        console.log(`[boot] Auto-restore gave up after ${MAX_RETRIES} attempts: ${e.message}`);
      }
    }
  }
  if (!probeResult) return;

  const playing = (typeof probeResult === 'object') ? probeResult.playing : false;
  if (playing) {
    streamControl.setModeState('live');
    console.log('[boot] Liquidsoap already playing, mode set to live');
    return;
  }

  // Phase 2: wait for autoplay (8s from Liquidsoap start + 4s margin)
  const elapsed = (Date.now() - start) / 1000;
  const waitForAutoplay = Math.max(0, 12 - elapsed) * 1000;
  if (waitForAutoplay > 0) {
    await new Promise(r => setTimeout(r, waitForAutoplay));
  }
  if (_bootAborted) { console.log('[boot] Aborted by user'); return; }

  try {
    const status = await probeStatus();
    if (status && status.playing) {
      streamControl.setModeState('live');
      console.log('[boot] Liquidsoap autoplay active, mode set to live');
      return;
    }
  } catch (e) {
    // Continue to fallback
  }

  // Phase 3: fallback — manual cue + resume
  if (_bootAborted) { console.log('[boot] Aborted by user'); return; }
  try {
    const processedDir = '/music/processed';
    const files = (await fs.promises.readdir(processedDir)).filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
    if (files.length === 0) {
      console.log('[boot] No tracks found, cannot auto-restore');
      return;
    }

    try {
      const recheck = await probeStatus();
      if (recheck && recheck.playing) {
        streamControl.setModeState('live');
        console.log('[boot] Liquidsoap started playing during fallback prep, mode set to live');
        return;
      }
    } catch (e) { /* continue with fallback */ }

    if (_bootAborted) { console.log('[boot] Aborted by user'); return; }
    const track = files[Math.floor(Math.random() * files.length)];
    const fullPath = path.join(processedDir, track);

    if (s3.S3_ENABLED) {
      try { await s3.ensureCached(`music/processed/${track}`, fullPath); } catch (e) {
        console.error(`[boot] S3 download for cue failed: ${e.message}`);
      }
    }

    await liqClient.cueTrack(fullPath);
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (_bootAborted) { console.log('[boot] Aborted by user during buffer wait'); return; }
    await liqClient.resumePlayback();
    fs.writeFileSync('/shared/current_audio.txt', fullPath);
    streamControl.setModeState('live');
    const totalElapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[boot] Auto-restored (fallback): cued ${track}, gate opened (${totalElapsed}s)`);
  } catch (e) {
    console.log(`[boot] Auto-restore cue/resume failed: ${e.message}`);
  }
}

module.exports = { boot, setBootAborted, isBootAborted };

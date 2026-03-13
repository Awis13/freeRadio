const fs = require('fs');
const http = require('http');
const path = require('path');
const liqClient = require('./liqClient');
const s3 = require('./s3');
const cacheManager = require('./cacheManager');
const streamControl = require('./streamControl');
const syncWatcher = require('./syncWatcher');

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

  // S3 boot sync
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
      // Restore raw content files (music + visuals) from S3
      await syncWatcher.init();
      syncWatcher.start();

      const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
      console.log(`[s3] boot sync completed in ${elapsed}s`);
    } catch (e) {
      console.error(`[s3] boot sync failed: ${e.message}`);
    }
  }

  // Check saved mode — respect last state before restart
  const savedMode = streamControl.getModeState().mode;
  console.log(`[boot] saved mode: ${savedMode}`);

  // Wait for Liquidsoap to be ready
  const MAX_RETRIES = 30;
  const RETRY_INTERVAL = 2000;
  await new Promise(r => setTimeout(r, 1000));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_bootAborted) { console.log('[boot] aborted'); return; }
    try {
      await probeStatus();
      break;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`[boot] Liquidsoap not ready (${attempt}/${MAX_RETRIES}): ${e.message}`);
        await new Promise(r => setTimeout(r, RETRY_INTERVAL));
      } else {
        console.log(`[boot] Liquidsoap unreachable after ${MAX_RETRIES} attempts`);
        return;
      }
    }
  }

  // Always start off — user must press PLAY
  try { await liqClient.stopPlayback(); } catch (e) {}
  if (savedMode === 'live') {
    console.log('[boot] was live before restart, waiting for PLAY');
  } else {
    console.log('[boot] was off, staying off');
  }
}

module.exports = { boot, setBootAborted, isBootAborted };

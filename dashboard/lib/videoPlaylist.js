const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');
const { createPlaylistStore } = require('./playlistStore');

const PLAYLIST_FILE = paths.shared('video_playlists.json');
const ACTIVE_FILE = paths.shared('active_visual_profile.json');
const QUEUE_FILE = paths.shared('video_queue.txt');
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv)$/i;

/**
 * Video playlists. Everything shared with the audio domain lives in
 * playlistStore.js; this file holds what is genuinely video-only: the file it
 * stores under, the id prefix, the extensions it accepts, the fact that clips
 * live in <visualsDir>/.processed rather than in the directory itself, and the
 * three things audio has no equivalent for — loading the video queue,
 * activating a shuffle profile, and clearing that profile on delete.
 *
 * Smart rules stay at their defaults: video has neither a bpm map nor genre
 * metadata, so those filters do not apply (T10-C2 kept that deliberately).
 */
const store = createPlaylistStore({
  file: PLAYLIST_FILE,
  idPrefix: 'vpl_',
  extensions: VIDEO_EXTENSIONS,
  trackDir: (visualsDir) => path.join(visualsDir, '.processed'),
});

function createVideoPlaylistRouter(visualsDir) {
  return store.createRouter(visualsDir, {
    // Clean up the active profile if the playlist being deleted was activated.
    beforeDelete(id) {
      const active = readStore(ACTIVE_FILE, null);
      if (active && active.id === id) {
        try {
          fs.unlinkSync(ACTIVE_FILE);
        } catch (e) { /* already gone */ }
      }
    },

    extraRoutes(router) {
      // POST /api/video-playlists/:id/load-queue — load into video queue
      router.post('/:id/load-queue', (req, res) => {
        const playlist = store.get(req.params.id);
        if (!playlist) return res.status(404).json({ error: 'not found' });

        const resolved = store.resolve(req.params.id, visualsDir);
        if (resolved.length === 0) {
          return res.status(400).json({ error: 'playlist resolves to 0 videos' });
        }

        const visualMode = require('./visualMode');

        // Atomic write: temp file + rename (same pattern as visualMode.js).
        // Not jsonStore — the queue is newline-separated text, not JSON.
        const sanitized = resolved.map(f => path.basename(f));
        const content = sanitized.join('\n') + '\n';
        const tmpFile = QUEUE_FILE + '.tmp';
        fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
        fs.writeFileSync(tmpFile, content);
        fs.renameSync(tmpFile, QUEUE_FILE);

        visualMode.setVisualMode('video-playlist');

        res.json({ ok: true, loaded: resolved.length, videos: resolved });
      });

      // POST /api/video-playlists/:id/activate-profile — set as shuffle profile
      router.post('/:id/activate-profile', (req, res) => {
        const playlist = store.get(req.params.id);
        if (!playlist) return res.status(404).json({ error: 'not found' });

        const resolved = store.resolve(req.params.id, visualsDir);
        if (resolved.length === 0) {
          return res.status(400).json({ error: 'playlist resolves to 0 videos' });
        }

        const visualMode = require('./visualMode');

        // Sanitize resolved filenames before writing
        const sanitized = resolved.map(f => path.basename(f));

        const payload = {
          id: playlist.id,
          name: playlist.name,
          videos: sanitized,
          activatedAt: Date.now()
        };
        writeStore(ACTIVE_FILE, payload);

        visualMode.setVisualMode('visual-radio');

        res.json({ activated: true, videoCount: resolved.length, mode: 'visual-radio' });
      });
    },
  });
}

module.exports = {
  createVideoPlaylistRouter,
  resolveVideoPlaylist: store.resolve,
  resolveSmartVideoPlaylist: store.resolveSmart,
  getVideoPlaylist: store.get,
  loadVideoPlaylists: store.load,
  saveVideoPlaylists: store.save
};

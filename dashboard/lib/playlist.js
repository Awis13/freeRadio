const fs = require('fs');
const path = require('path');
const multer = require('multer');
const paths = require('./paths');
const { createPlaylistStore } = require('./playlistStore');

const PLAYLIST_FILE = paths.shared('playlists.json');
const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|aac|m4a)$/i;

/**
 * Audio playlists. Everything shared with the video domain lives in
 * playlistStore.js; this file holds what is genuinely audio-only: the file it
 * stores under, the id prefix, the extensions it accepts, the fact that tracks
 * sit directly in the music directory, the bpm and genre smart rules, and the
 * m3u/pls import endpoint.
 */
const store = createPlaylistStore({
  file: PLAYLIST_FILE,
  idPrefix: 'pl_',
  extensions: AUDIO_EXTENSIONS,
  // Audio tracks live directly in the directory the router is given.
  trackDir: (dir) => dir,
  // Audio is the only domain with a bpm map and genre metadata.
  smartRules: { bpm: true, genre: true },
});

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const tracks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Extract just the filename
    const basename = trimmed.split('/').pop().split('\\').pop();
    if (basename && AUDIO_EXTENSIONS.test(basename)) {
      tracks.push(basename);
    }
  }
  return tracks;
}

function createPlaylistRouter(musicDir, getBpmMap) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

  return store.createRouter(musicDir, {
    getBpmMap,
    extraRoutes(router) {
      // POST /api/playlists/import — import m3u/pls
      router.post('/import', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'no file' });

        const content = req.file.buffer.toString('utf8');
        const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/, '') || 'Imported';

        let tracks;
        if (req.file.originalname.endsWith('.pls')) {
          // PLS format
          tracks = content.split(/\r?\n/)
            .filter(l => l.startsWith('File'))
            .map(l => l.split('=').slice(1).join('=').trim())
            .map(p => p.split('/').pop().split('\\').pop())
            .filter(f => AUDIO_EXTENSIONS.test(f));
        } else {
          tracks = parseM3U(content);
        }

        // Filter to only tracks that exist
        const existingTracks = tracks.filter(t => {
          const safe = path.basename(t);
          return safe && safe === t && fs.existsSync(path.join(musicDir, safe));
        });

        const id = 'pl_' + Date.now();
        const now = Date.now();
        const playlist = {
          id,
          name,
          type: 'manual',
          tracks: existingTracks,
          createdAt: now,
          updatedAt: now
        };

        const data = store.load();
        data.playlists[id] = playlist;
        store.save(data);

        res.json({ ...playlist, importedCount: existingTracks.length, totalParsed: tracks.length });
      });
    },
  });
}

module.exports = {
  createPlaylistRouter,
  resolvePlaylist: store.resolve,
  getPlaylist: store.get,
  loadPlaylists: store.load
};

// Export internal functions for unit tests
module.exports._test = { parseM3U };

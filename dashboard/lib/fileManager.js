const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv']);

function fileManager(dir) {
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename(req, file, cb) {
        // Sanitize: strip path separators, keep original name
        const safe = file.originalname.replace(/[/\\]/g, '_');
        cb(null, safe);
      }
    }),
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
  });

  // GET / — list files
  router.get('/', (req, res) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => {
          const stat = fs.statSync(path.join(dir, e.name));
          return {
            name: e.name,
            size: stat.size,
            modified: stat.mtimeMs
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json(files);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST / — upload file(s)
  router.post('/', upload.array('files', 20), (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const uploaded = req.files.map((f) => ({ name: f.filename, size: f.size }));
    res.json({ uploaded });
  });

  // DELETE /:name — delete a file
  router.delete('/:name', (req, res) => {
    const name = req.params.name;
    // Prevent path traversal
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(dir, name);
    try {
      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'File not found' });
      }
      fs.unlinkSync(filepath);
      res.json({ deleted: name });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = fileManager;

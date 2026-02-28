const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const s3 = require('./s3');
const transcoder = require('./transcoderClient');

// Determine S3 prefix from local directory
function dirToS3Prefix(dir) {
  if (dir.includes('/music')) return 'music/raw/';
  if (dir.includes('/visuals')) return 'visuals/incoming/';
  return '';
}

// Find processed version of a file (transcoder changes extension: mp3->wav, mov->mp4)
function findProcessed(dir, name) {
  const base = name.replace(/\.[^.]+$/, '');
  if (dir.includes('/music')) {
    return { dir: path.join(dir, 'processed'), s3Prefix: 'music/processed/', base };
  }
  if (dir.includes('/visuals')) {
    const root = dir.replace(/\/incoming\/?$/, '');
    return { dir: path.join(root, '.processed'), s3Prefix: 'visuals/processed/', base };
  }
  return null;
}

// Delete all processed versions of a file (local + S3)
async function deleteProcessed(dir, name) {
  const info = findProcessed(dir, name);
  if (!info) return [];
  const deleted = [];
  try {
    const files = fs.readdirSync(info.dir);
    for (const f of files) {
      const fBase = f.replace(/\.[^.]+$/, '');
      if (fBase !== info.base) continue;
      // Delete locally
      try {
        fs.unlinkSync(path.join(info.dir, f));
      } catch (e) {
        console.error(`[fileManager] cascade delete local failed: ${f}: ${e.message}`);
        continue; // don't push to deleted, don't try S3
      }
      // Delete from S3
      if (s3.S3_ENABLED) {
        try { await s3.remove(info.s3Prefix + f); } catch (e) {
          console.error(`[fileManager] cascade delete S3 failed: ${f}: ${e.message}`);
        }
      }
      deleted.push(f);
      console.log(`[fileManager] cascade delete processed: ${f}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[fileManager] deleteProcessed error: ${e.message}`);
  }
  return deleted;
}

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
  router.post('/', upload.array('files', 20), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const uploaded = req.files.map((f) => ({ name: f.filename, size: f.size }));
    const isVisuals = dir.includes('/visuals');

    // Визуалы → транскодер (если включён), иначе fallback на S3
    if (isVisuals && transcoder.ENABLED) {
      const transcodeResults = [];
      for (const f of req.files) {
        try {
          const result = await transcoder.submit(f.path);
          transcodeResults.push({ name: f.filename, job_id: result.job_id, status: result.status });
          console.log(`[transcoder] отправлено: ${f.filename} → job ${result.job_id}`);
        } catch (e) {
          console.error(`[transcoder] ошибка: ${f.filename}: ${e.message}`);
          transcodeResults.push({ name: f.filename, error: e.message });
        }
      }
      return res.json({ uploaded, transcode: transcodeResults });
    }

    // Музыка или fallback (нет транскодера) → S3
    const s3Results = [];
    if (s3.S3_ENABLED) {
      const prefix = dirToS3Prefix(dir);
      for (const f of req.files) {
        try {
          await s3.upload(f.path, prefix + f.filename);
          s3Results.push({ name: f.filename, s3: true });
        } catch (e) {
          console.error(`[s3] upload failed: ${f.filename}: ${e.message}`);
          s3Results.push({ name: f.filename, s3: false, error: e.message });
        }
      }
    }

    res.json({ uploaded, ...(s3Results.length > 0 && { s3: s3Results }) });
  });

  // DELETE /:name — delete a file
  router.delete('/:name', async (req, res) => {
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

      // S3 sync — await before responding
      let s3ok = null;
      if (s3.S3_ENABLED) {
        const prefix = dirToS3Prefix(dir);
        try {
          await s3.remove(prefix + name);
          s3ok = true;
        } catch (e) {
          console.error(`[s3] delete failed: ${name}: ${e.message}`);
          s3ok = false;
        }
      }

      // Cascade delete processed version (local + S3)
      const processedDeleted = await deleteProcessed(dir, name);

      res.json({ deleted: name, ...(s3ok !== null && { s3: s3ok }), ...(processedDeleted.length > 0 && { processedDeleted }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = fileManager;

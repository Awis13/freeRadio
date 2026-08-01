const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const s3 = require('./s3');
const transcoder = require('./transcoderClient');
const paths = require('./paths');

// DIRECTORY CLASSIFICATION. Three places in this file decide whether a
// directory is music or visuals — dirToS3Prefix, findProcessed and the upload
// handler's isVisuals — and all of them test `dir.includes(paths.MUSIC_DIR)` /
// `dir.includes(paths.VISUALS_DIR)`. Matching the CONFIGURED roots is
// deliberate: if those directories move, the classification moves with them.
// Substring rather than startsWith is the existing behaviour and is kept as-is,
// because callers pass subdirectories (…/incoming, …/processed) as well as the
// roots themselves.

// Determine S3 prefix from local directory
function dirToS3Prefix(dir) {
  if (dir.includes(paths.MUSIC_DIR)) return 'music/raw/';
  if (dir.includes(paths.VISUALS_DIR)) return 'visuals/incoming/';
  return '';
}

// Find processed version of a file (transcoder changes extension: mp3->wav, mov->mp4)
function findProcessed(dir, name) {
  const base = name.replace(/\.[^.]+$/, '');
  if (dir.includes(paths.MUSIC_DIR)) {
    return { dir: path.join(dir, 'processed'), s3Prefix: 'music/processed/', base };
  }
  if (dir.includes(paths.VISUALS_DIR)) {
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

// Background poll for transcoder job → download result from S3 when ready
function pollAndDownload(jobId, filename, dir) {
  const outputName = filename.replace(/\.[^.]+$/, '') + '.mp4';
  const processedDir = dir.replace(/\/incoming\/?$/, '') + '/.processed';
  const localPath = path.join(processedDir, outputName);
  const s3Key = 'visuals/processed/' + outputName;
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes (120 * 5s)

  const timer = setInterval(async () => {
    attempts++;
    try {
      const job = await transcoder.getJob(jobId);
      if (!job) { clearInterval(timer); return; }
      if (job.status === 'done') {
        clearInterval(timer);
        if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
        await s3.download(s3Key, localPath);
        console.log(`[transcoder] done: ${outputName} → ${localPath}`);
      } else if (job.status === 'error') {
        clearInterval(timer);
        console.error(`[transcoder] job error ${jobId}: ${job.error || 'unknown'}`);
      }
    } catch (e) {
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        console.error(`[transcoder] poll timeout ${jobId} after ${maxAttempts} attempts`);
      }
    }
  }, 3000); // every 3 seconds
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
    const isVisuals = dir.includes(paths.VISUALS_DIR);

    // Visuals → transcoder (if enabled), otherwise fallback to S3
    if (isVisuals && transcoder.ENABLED) {
      const transcodeResults = [];
      for (const f of req.files) {
        try {
          const result = await transcoder.submit(f.path);
          transcodeResults.push({ name: f.filename, job_id: result.job_id, status: result.status });
          console.log(`[transcoder] submitted: ${f.filename} → job ${result.job_id}`);
          // Background poll: wait for completion → download result from S3
          pollAndDownload(result.job_id, f.filename, dir);
        } catch (e) {
          console.error(`[transcoder] error: ${f.filename}: ${e.message}`);
          transcodeResults.push({ name: f.filename, error: e.message });
        }
      }
      return res.json({ uploaded, transcode: transcodeResults });
    }

    // Music or fallback (no transcoder) → S3
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

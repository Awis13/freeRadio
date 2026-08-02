/**
 * httpErrors.js — the two shared error responses the routers were writing by
 * hand, inconsistently.
 *
 * upstreamError      answers a failed call to something outside this process
 *                    (liquidsoap/the DJ, S3) without inventing an attribution.
 * uploadErrorHandler the app-level handler for multer and body-parser
 *                    rejections, which Express otherwise turns into a 500.
 */

const multer = require('multer');

/**
 * Reports an upstream failure as a 502 and logs the real cause.
 *
 * The handlers this replaces all wrote `catch (e) { res.status(502).json(...) }`
 * and then dropped `e` on the floor, so a failure anywhere inside the try block
 * came back as one flat string with nothing left to debug from — and, in
 * queue.js, was attributed to whichever upstream the message happened to name.
 * `upstream` is a required argument precisely because the caller is the only
 * one that knows which service it was talking to.
 */
function upstreamError(res, e, upstream) {
  console.error(`[${upstream}] request failed: ${(e && e.message) || e}`);
  return res.status(502).json({ error: `${upstream} unavailable` });
}

/**
 * Turns a rejected upload or an unparseable body into the 400 it is.
 *
 * Four multer surfaces (file-manager uploads, overlay assets, playlist import,
 * voice send) reject requests through multer's own error path — a size limit,
 * an unexpected field name, or overlay's fileFilter refusing a non-image. With
 * no error middleware mounted, Express's default handler answered every one of
 * them with a 500 and an HTML stack trace, so a user picking the wrong file got
 * a server error. express.json() rejects malformed JSON the same way.
 *
 * Anything that is not recognisably the caller's fault is passed through to
 * Express's default handler untouched: a genuine bug must stay a 500 rather
 * than being laundered into a 400.
 */
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();
  // A response already on the wire cannot be rewritten; Express's default
  // handler is the one that knows how to abort it.
  if (res.headersSent) return next(err);

  // MulterError carries no status of its own. body-parser sets status/
  // statusCode 400 itself, and so does overlay's fileFilter rejection.
  //
  // Matched by name as well as by instanceof: a second copy of multer anywhere
  // in the tree (a transitive dependency resolving its own) produces errors
  // whose prototype chain does not lead to THIS module's MulterError, and an
  // instanceof-only test would quietly hand those to the 500 path.
  const isMulterError = err instanceof multer.MulterError || err.name === 'MulterError';
  const status = isMulterError
    ? 400
    : (err.status || err.statusCode || 500);
  if (status >= 500) return next(err);

  return res.status(status).json({ error: err.message });
}

module.exports = { upstreamError, uploadErrorHandler };

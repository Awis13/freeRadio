#!/bin/sh
# Fix ownership of writable volumes for non-root user
chown -R app:app /shared 2>/dev/null || true
# /music and /visuals need write access for uploads and transcoded files
chown -R app:app /music 2>/dev/null || true
chown -R app:app /visuals 2>/dev/null || true
exec su-exec app node server.js

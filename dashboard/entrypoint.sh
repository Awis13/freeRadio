#!/bin/sh
# Fix ownership of writable volumes for the non-root app user.
#
# These used to be three unconditional `chown -R` calls. /music and /visuals are
# the media libraries: on a stocked tenant that is a recursive walk over
# thousands of files on every container start, before the server binds its port.
# The ownership it fixes only ever changes when a volume is first created or
# replaced, so the walk was almost always a no-op that still touched every
# inode.
#
# The guard reads the ownership of the directory itself and skips the recursion
# when it already matches. Being honest about the trade: it checks the mount
# point, not its contents, so a file placed inside with foreign ownership after
# the first boot is no longer corrected here. Re-walking every library on every
# boot to catch that case was the wrong price.
APP_UID=$(id -u app)

ensure_owner() {
  dir="$1"
  [ -d "$dir" ] || return 0
  [ "$(stat -c %u "$dir" 2>/dev/null)" = "$APP_UID" ] && return 0
  chown -R app:app "$dir" 2>/dev/null || true
}

ensure_owner /shared
# /music and /visuals need write access for uploads and transcoded files.
ensure_owner /music
ensure_owner /visuals

exec su-exec app node server.js

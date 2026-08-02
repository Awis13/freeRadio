FROM node:24-alpine

RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app

# hls.js — fetched at build time, not vendored in the repo; server.js serves
# this file as /js/hls.min.js. Pinned: @latest made every rebuild a silent
# upgrade of the player the dashboard ships, with nothing in the repo recording
# which version an image actually got.
RUN wget -q -O /app/hls.min.js \
    https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js

# Lockfile is required, not optional: npm ci installs exactly what
# dashboard/package-lock.json pins, and a missing or stale lockfile must fail
# the build rather than silently resolving different versions.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN addgroup -S app && adduser -S app -G app

EXPOSE 9090

# /api/health is mounted ahead of the auth gate (it is in server.js's
# PUBLIC_PATHS), so this works with or without DASHBOARD_TOKEN set. wget is
# busybox's, present in every alpine image and verified in node:24-alpine
# specifically; it exits non-zero on a non-200, so a process that is up but not
# serving still fails. Declared here rather than in compose because this is our
# image: the check travels with it wherever it is deployed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:9090/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]

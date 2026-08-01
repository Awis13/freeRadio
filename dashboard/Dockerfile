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
ENTRYPOINT ["/app/entrypoint.sh"]

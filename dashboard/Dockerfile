FROM node:20-alpine

RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app

# hls.js — скачиваем при сборке
RUN wget -q -O /app/hls.min.js \
    https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

RUN addgroup -S app && adduser -S app -G app

EXPOSE 9090
ENTRYPOINT ["/app/entrypoint.sh"]

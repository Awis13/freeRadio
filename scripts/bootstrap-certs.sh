#!/bin/bash
# Generate a self-signed TLS certificate for the nginx proxy.
#
# nginx-proxy/nginx.conf hard-requires /certs/tls.crt and /certs/tls.key, and
# certs/ is gitignored, so a clean clone has no certificate and the proxy
# container exits on startup. This produces a usable pair so `docker compose up`
# works from a fresh checkout.
#
# Self-signed means browsers will warn. That is the right trade for local and
# first-boot use; for anything public, replace certs/tls.* with a real
# certificate — this script will not overwrite what is already there.
#
# Usage:
#   scripts/bootstrap-certs.sh                 # CN=localhost
#   CERT_CN=studio23.example scripts/bootstrap-certs.sh
#   CERT_DAYS=30 scripts/bootstrap-certs.sh
#   FORCE=1 scripts/bootstrap-certs.sh         # replace an existing pair
set -e

CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
CERT_CN="${CERT_CN:-localhost}"
CERT_DAYS="${CERT_DAYS:-825}"
CRT="${CERT_DIR}/tls.crt"
KEY="${CERT_DIR}/tls.key"

if ! command -v openssl >/dev/null 2>&1; then
  echo "[certs] openssl not found — install it, or drop your own tls.crt/tls.key into ${CERT_DIR}" >&2
  exit 1
fi

# Refuse to clobber if EITHER file is present, not just both. A lone tls.key
# with no certificate is still somebody's private key — quite possibly the
# match for a certificate they are about to drop in beside it — and silently
# generating over it would destroy something unrecoverable.
if [ -z "${FORCE:-}" ] && { [ -f "$CRT" ] || [ -f "$KEY" ]; }; then
  if [ -f "$CRT" ] && [ -f "$KEY" ]; then
    echo "[certs] ${CRT} and ${KEY} already exist — leaving them alone (FORCE=1 to replace)"
    if openssl x509 -in "$CRT" -noout -checkend 0 >/dev/null 2>&1; then
      echo "[certs] current certificate is valid until $(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2)"
    else
      echo "[certs] WARNING: the existing certificate has EXPIRED — rerun with FORCE=1 to replace it" >&2
    fi
    exit 0
  fi
  found="$CRT"; missing="$KEY"
  [ -f "$KEY" ] && { found="$KEY"; missing="$CRT"; }
  echo "[certs] found ${found} but no ${missing} — refusing to overwrite half a keypair." >&2
  echo "[certs] Put the matching file next to it, or rerun with FORCE=1 to generate a fresh pair." >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

# The key is written with 600 below, but chmod runs AFTER openssl has created
# the file; umask closes that window instead of narrowing it.
umask 077

# subjectAltName as well as CN: browsers and most clients have ignored CN for
# host matching for years, so a CN-only certificate fails validation outright.
# localhost and 127.0.0.1 are always included, and not repeated when CERT_CN is
# already one of them.
SAN="DNS:${CERT_CN}"
[ "$CERT_CN" != "localhost" ] && SAN="${SAN},DNS:localhost"
[ "$CERT_CN" != "127.0.0.1" ] && SAN="${SAN},IP:127.0.0.1"

# Keep openssl's own diagnostics: without them a failure here aborts the script
# under set -e with nothing to go on.
if ! err="$(openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CRT" \
  -days "$CERT_DAYS" \
  -subj "/CN=${CERT_CN}" \
  -addext "subjectAltName=${SAN}" 2>&1)"; then
  echo "[certs] openssl failed to generate the keypair:" >&2
  echo "$err" >&2
  exit 1
fi

chmod 600 "$KEY"
chmod 644 "$CRT"

echo "[certs] wrote ${CRT} and ${KEY} (CN=${CERT_CN}, ${CERT_DAYS} days, self-signed)"
echo "[certs] the proxy mounts this directory read-only at /certs; docker compose up will pick it up"

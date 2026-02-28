#!/bin/bash
# Deploy STUDIO 23 (freeRadio) to LXC 100 via Proxmox
# Jenkins pipeline: ssh root@95.217.38.43 'bash -s' < deploy-studio23.sh
set -euo pipefail

PROXMOX_HOST="95.217.38.43"
LXC_ID="${LXC_ID:-100}"
REPO_DIR="/root/freeRadio"
BRANCH="${1:-master}"

echo ""
echo "========================================"
echo "🚀 Deploy STUDIO 23 (LXC ${LXC_ID})"
echo "========================================"
echo ""
echo "📅 $(date '+%Y-%m-%d %H:%M:%S')"
echo "🌿 Branch: ${BRANCH}"
echo ""

# --- Telegram notify (inline — скрипт пайпится через SSH) ---
notify() {
    local title="$1"
    local body="$2"
    if [ -z "${TG_BOT_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then return; fi
    local text="<b>${title}</b>
${body}
🕐 $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    curl -s --max-time 10 -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
        -d chat_id="$TG_CHAT_ID" -d parse_mode=HTML -d text="$text" > /dev/null 2>&1 || true
}

# --- Выполнение команд внутри LXC через pct exec ---
lxc_exec() {
    pct exec "$LXC_ID" -- bash -c "$1"
}

# --- git pull ---
echo "📥 Pulling latest code..."
LOCAL=$(lxc_exec "cd ${REPO_DIR} && git rev-parse HEAD")
lxc_exec "cd ${REPO_DIR} && git fetch origin ${BRANCH}"
REMOTE=$(lxc_exec "cd ${REPO_DIR} && git rev-parse origin/${BRANCH}")

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "   ✅ Already up to date (${LOCAL:0:7})"
    echo ""
    echo "   Checking if containers are running..."
    RUNNING=$(lxc_exec "cd ${REPO_DIR} && docker compose ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -c 'Up' || echo 0")
    if [ "$RUNNING" -ge 5 ]; then
        echo "   ✅ ${RUNNING} containers running, nothing to do"
        echo ""
        echo "========================================"
        exit 0
    fi
    echo "   ⚠️  Only ${RUNNING} containers running, redeploying..."
fi

CHANGES=$(lxc_exec "cd ${REPO_DIR} && git log --oneline ${LOCAL}..${REMOTE} 2>/dev/null || echo 'initial deploy'")
lxc_exec "cd ${REPO_DIR} && git reset --hard origin/${BRANCH}"
VERSION=$(lxc_exec "cd ${REPO_DIR} && git rev-parse --short HEAD")
echo "   ✅ Updated to ${VERSION}"
echo ""
echo "📝 Changes:"
echo "$CHANGES"
echo ""

# --- deploy ---
echo "🔨 Deploying..."
lxc_exec "cd ${REPO_DIR} && docker compose up -d --remove-orphans 2>&1" | tail -20
echo ""

# --- health check ---
echo "⏳ Waiting for services..."
sleep 10

RETRIES=0
MAX_RETRIES=6
while [ $RETRIES -lt $MAX_RETRIES ]; do
    RUNNING=$(lxc_exec "cd ${REPO_DIR} && docker compose ps --format '{{.Status}}' 2>/dev/null | grep -c 'Up' || echo 0")
    TOTAL=$(lxc_exec "cd ${REPO_DIR} && docker compose ps --format '{{.Name}}' 2>/dev/null | wc -l || echo 0")
    if [ "$RUNNING" -ge "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
        echo "   ✅ All ${RUNNING}/${TOTAL} services running"
        break
    fi
    RETRIES=$((RETRIES + 1))
    if [ $RETRIES -eq $MAX_RETRIES ]; then
        echo "   🔴 Only ${RUNNING}/${TOTAL} services running after ${MAX_RETRIES} attempts"
        lxc_exec "cd ${REPO_DIR} && docker compose ps 2>/dev/null"
        notify "🔴 Deploy FAILED: studio23 (LXC ${LXC_ID})" "Only ${RUNNING}/${TOTAL} services running.
Version: ${VERSION}"
        exit 1
    fi
    echo "   ${RUNNING}/${TOTAL} running, waiting..."
    sleep 10
done

# --- verify dashboard ---
echo ""
echo "🔍 Verification:"
DASH_IP=$(lxc_exec "hostname -I | awk '{print \$1}'")
HTTP_CODE=$(lxc_exec "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9090/api/status 2>/dev/null || echo 000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ Dashboard API → ${HTTP_CODE}"
else
    echo "   ⚠️  Dashboard API → ${HTTP_CODE} (may still be starting)"
fi

echo "   📦 Version: ${VERSION}"
echo "   🖥️  LXC: ${LXC_ID} (${DASH_IP})"
echo ""

# --- уведомление ---
CHANGE_SUMMARY=$(echo "$CHANGES" | head -5)
notify "✅ Deployed: studio23 (LXC ${LXC_ID})" "Version: ${VERSION}

${CHANGE_SUMMARY}"

echo "========================================"

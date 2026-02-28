#!/bin/bash
# Proxmox hookscript: создаёт медиа-директории для тенанта при старте LXC
# Установка: pct set <VMID> --hookscript local:snippets/tenant-media.sh
# Копировать: cp tenant-media.sh /var/lib/vz/snippets/tenant-media.sh && chmod +x /var/lib/vz/snippets/tenant-media.sh

VMID="$1"
PHASE="$2"

# Пропускаем системные контейнеры
# 100 = production
# 199 = централизованный транскодер
# 200 = template
if [ "$VMID" -le 100 ] 2>/dev/null || [ "$VMID" -eq 199 ] 2>/dev/null || [ "$VMID" -eq 200 ] 2>/dev/null; then
    exit 0
fi

if [ "$PHASE" == "pre-start" ]; then
    mkdir -p "/mnt/tenants/${VMID}/visuals/incoming"
    mkdir -p "/mnt/tenants/${VMID}/visuals/.processed"
    mkdir -p "/mnt/tenants/${VMID}/music"
    mkdir -p "/mnt/tenants/${VMID}/music/processed"
    echo "$(date '+%Y-%m-%d %H:%M:%S') pre-start: Created media dirs for LXC ${VMID}" >> /var/log/tenant-hookscript.log
fi

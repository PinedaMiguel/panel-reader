#!/usr/bin/env bash
# One-time server setup (Ubuntu 24.04, run as root): Caddy, uv, app user, swap, firewall, service.
#   ssh root@<ip> 'bash -s' < deploy/setup.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq caddy rsync

# Swap: the panel model + PyTorch peak around 4 GB; swap keeps a spike from killing the job.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id app >/dev/null 2>&1 || useradd --create-home --shell /bin/bash app
mkdir -p /srv/panel-reader/{api,web,media,hf-cache}
chown -R app:app /srv/panel-reader

# uv (Python manager) for the app user
sudo -u app bash -lc 'command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh'

if command -v ufw >/dev/null; then
  ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
fi

cat > /etc/systemd/system/panel-reader.service <<'UNIT'
[Unit]
Description=Panel Reader API
After=network-online.target

[Service]
User=app
WorkingDirectory=/srv/panel-reader/api
EnvironmentFile=/srv/panel-reader/.env
Environment=HF_HOME=/srv/panel-reader/hf-cache
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/app/.local/bin/uv run --frozen uvicorn api.main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable panel-reader
echo "setup done"

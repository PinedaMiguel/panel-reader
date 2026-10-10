#!/usr/bin/env bash
# Build and ship to the server, then restart. Usage: deploy/deploy.sh <server-ip> [site-host]
#   site-host defaults to <ip-with-dashes>.sslip.io (free HTTPS name until the domain is ready)
set -euo pipefail
cd "$(dirname "$0")/.."

IP=${1:?usage: deploy/deploy.sh <server-ip> [site-host]}
HOST=${2:-${IP//./-}.sslip.io}
SSH="ssh -i $HOME/.ssh/knighthacks_vultr -o StrictHostKeyChecking=accept-new root@$IP"
RSYNC="rsync -az --delete -e 'ssh -i $HOME/.ssh/knighthacks_vultr'"

echo "→ building web"
(cd web && npm run build >/dev/null)

echo "→ uploading"
eval $RSYNC --exclude .venv --exclude __pycache__ api/ root@$IP:/srv/panel-reader/api/
eval $RSYNC web/dist/ root@$IP:/srv/panel-reader/web/
# Secrets the server needs (not the Vultr key).
grep -v '^VULTR_API_KEY=' .env | $SSH 'cat > /srv/panel-reader/.env && chmod 600 /srv/panel-reader/.env'
scp -q -i "$HOME/.ssh/knighthacks_vultr" deploy/Caddyfile root@$IP:/etc/caddy/Caddyfile

echo "→ installing and restarting"
$SSH bash -s <<REMOTE
set -euo pipefail
chown -R app:app /srv/panel-reader
sudo -u app bash -lc 'cd /srv/panel-reader/api && uv sync --frozen --no-dev -q'
echo 'SITE_HOST=$HOST' > /etc/default/caddy
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/env.conf
systemctl daemon-reload
systemctl restart panel-reader caddy
REMOTE

echo "✓ https://$HOST"

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
# Reading-only server: it gets the Neon database and storage credentials and nothing else. No Gemini or
# ElevenLabs keys (it serves what's already stored) and no ADMIN_TOKEN (uploads are refused outright).
grep -E '^(DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_ENDPOINT_URL_S3|AWS_REGION)=' .env | $SSH 'cat > /srv/panel-reader/.env && chmod 600 /srv/panel-reader/.env'
scp -q -i "$HOME/.ssh/knighthacks_vultr" deploy/Caddyfile root@$IP:/etc/caddy/Caddyfile

echo "→ installing and restarting"
$SSH bash -s <<REMOTE
set -euo pipefail
chown -R app:app /srv/panel-reader
sudo -u app bash -lc 'cd /srv/panel-reader/api && uv sync --frozen --no-dev --no-group magi -q'  # reading-only: no Magi
echo 'SITE_HOST=$HOST' > /etc/default/caddy
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/env.conf
systemctl daemon-reload
systemctl restart panel-reader caddy
REMOTE

echo "✓ https://$HOST"

#!/usr/bin/env bash
set -euo pipefail

# Full server mirror into server-mirror/ and server-mirror-secrets/
# Usage: scripts/mirror/pull-full.sh [user@host] [ssh_key_path]

HOST="${1:-root@116.203.208.144}"
KEY="${2:-$HOME/.ssh/hetzner_short_key}"

echo "Using host: $HOST"
echo "Using key : $KEY"

SSH="ssh -i $KEY -o ConnectTimeout=5"
# Common excludes for generated or heavy artifacts we do not want in Git
RSYNC_EXCLUDES=(
  --exclude 'node_modules'
  --exclude 'target'
  --exclude '.next'
  --exclude '.git'
  --exclude '.cache'
  --exclude 'logs'
  --exclude 'backups'
)
rrsync() { rsync -avz --delete "${RSYNC_EXCLUDES[@]}" -e "ssh -i $KEY -o ConnectTimeout=5" "$@"; }

ROOT_DIR="server-mirror"
SECRETS_DIR="server-mirror-secrets"

mkdir -p "$ROOT_DIR/docs" "$SECRETS_DIR"

log() { echo "[mirror] $*"; }

pull_www() {
  log "Mirroring /var/www -> $ROOT_DIR/www"
  mkdir -p "$ROOT_DIR/www"
  rrsync "$HOST:/var/www/" "$ROOT_DIR/www/"
}

pull_nginx() {
  log "Capturing nginx -T"
  mkdir -p "$ROOT_DIR/nginx"
  $SSH "$HOST" "nginx -T" > "$ROOT_DIR/nginx/nginx.conf.full" 2>&1 || true
  for d in /etc/nginx/nginx.conf /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    if $SSH "$HOST" "test -e $d"; then
      rel=$(echo "$d" | sed 's#^/##')
      mkdir -p "$ROOT_DIR/nginx/$(dirname "$rel")"
      log "Mirroring nginx: $d"
      rrsync "$HOST:$d" "$ROOT_DIR/nginx/$(dirname "$rel")/"
    fi
  done
}

pull_letsencrypt() {
  log "Mirroring /etc/letsencrypt -> $SECRETS_DIR/letsencrypt (gitignored)"
  mkdir -p "$SECRETS_DIR/letsencrypt"
  rrsync "$HOST:/etc/letsencrypt/" "$SECRETS_DIR/letsencrypt/" || true
}

pull_systemd() {
  log "Mirroring systemd units"
  mkdir -p "$ROOT_DIR/system/systemd/etc" "$ROOT_DIR/system/systemd/lib"
  rrsync "$HOST:/etc/systemd/system/" "$ROOT_DIR/system/systemd/etc/" || true
  rrsync "$HOST:/lib/systemd/system/" "$ROOT_DIR/system/systemd/lib/" || true
  log "Capturing enabled units list"
  $SSH "$HOST" "systemctl list-unit-files --type=service --no-pager --all" > "$ROOT_DIR/system/systemd/services.list" || true
}

pull_cron() {
  log "Mirroring cron"
  mkdir -p "$ROOT_DIR/system/cron"
  rrsync "$HOST:/etc/crontab" "$ROOT_DIR/system/cron/" || true
  for d in /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly; do
    rrsync "$HOST:$d" "$ROOT_DIR/system/cron/" || true
  done
  log "Capturing root crontab"
  $SSH "$HOST" "crontab -l" > "$ROOT_DIR/system/cron/root.crontab" 2>/dev/null || true
}

pull_usr_local_bin() {
  log "Mirroring /usr/local/bin"
  mkdir -p "$ROOT_DIR/system/usr-local-bin"
  rrsync "$HOST:/usr/local/bin/" "$ROOT_DIR/system/usr-local-bin/" || true
}

pull_pm2() {
  log "Attempting to mirror PM2 data"
  mkdir -p "$ROOT_DIR/system/pm2"
  rrsync "$HOST:/root/.pm2/" "$ROOT_DIR/system/pm2/root.pm2/" || true
  rrsync "$HOST:/home/*/.pm2/" "$ROOT_DIR/system/pm2/users/" || true
  $SSH "$HOST" "command -v pm2 >/dev/null 2>&1 && pm2 ls || true" > "$ROOT_DIR/system/pm2/pm2.ls.txt" 2>&1 || true
}

pull_docker() {
  log "Mirroring Docker configs and inventory"
  mkdir -p "$ROOT_DIR/docker/etc-docker" "$ROOT_DIR/docker/inventory"
  rrsync "$HOST:/etc/docker/" "$ROOT_DIR/docker/etc-docker/" || true
  $SSH "$HOST" "docker ps -a" > "$ROOT_DIR/docker/inventory/ps.txt" 2>&1 || true
  $SSH "$HOST" "docker images" > "$ROOT_DIR/docker/inventory/images.txt" 2>&1 || true
  $SSH "$HOST" "docker network ls" > "$ROOT_DIR/docker/inventory/networks.txt" 2>&1 || true

  log "Discovering docker-compose files in common locations"
  tmpfile=$(mktemp)
  $SSH "$HOST" "set -e; for dir in /opt /srv /root /var/www; do test -d \$dir || continue; find \$dir -maxdepth 3 -type f -name 'docker-compose*.y*ml' -o -name 'compose.y*ml' 2>/dev/null; done" > "$tmpfile" || true
  while IFS= read -r remote_file; do
    [ -z "$remote_file" ] && continue
    # rsync the directory containing the compose file to preserve context
    rdir=$(dirname "$remote_file")
    rel=$(echo "$rdir" | sed 's#^/##')
    mkdir -p "$ROOT_DIR/docker/compose/$rel"
    log "Mirroring compose dir: $rdir"
    rrsync "$HOST:$rdir/" "$ROOT_DIR/docker/compose/$rel/" || true
  done < "$tmpfile"
  rm -f "$tmpfile"
}

pull_services_by_name() {
  log "Searching for service code directories (cosigner, pse, passkey, guardian)"
  mkdir -p "$ROOT_DIR/services"
  tmpfile=$(mktemp)
  $SSH "$HOST" "set -e; for base in /opt /srv /root /var /usr/local/src; do test -d \$base || continue; find \$base -maxdepth 3 -type d \( -iname '*cosign*' -o -iname '*pse*' -o -iname '*passkey*' -o -iname '*guardian*' -o -iname '*nuri*' \) 2>/dev/null; done" > "$tmpfile" || true
  while IFS= read -r rdir; do
    [ -z "$rdir" ] && continue
    name=$(basename "$rdir")
    safe=$(echo "$rdir" | sed 's#^/##')
    log "Mirroring service dir: $rdir"
    mkdir -p "$ROOT_DIR/services/$safe"
    rrsync "$HOST:$rdir/" "$ROOT_DIR/services/$safe/" || true
  done < "$tmpfile"
  rm -f "$tmpfile"
}

pull_inventory() {
  log "Capturing system inventory"
  mkdir -p "$ROOT_DIR/docs"
  $SSH "$HOST" "uname -a" > "$ROOT_DIR/docs/uname.txt" 2>&1 || true
  $SSH "$HOST" "cat /etc/os-release" > "$ROOT_DIR/docs/os-release.txt" 2>&1 || true
  $SSH "$HOST" "lsb_release -a" > "$ROOT_DIR/docs/lsb_release.txt" 2>&1 || true
  $SSH "$HOST" "nginx -v" > "$ROOT_DIR/docs/nginx-version.txt" 2>&1 || true
  $SSH "$HOST" "node --version" > "$ROOT_DIR/docs/node-version.txt" 2>&1 || true
  $SSH "$HOST" "npm --version" > "$ROOT_DIR/docs/npm-version.txt" 2>&1 || true
  $SSH "$HOST" "pm2 -v" > "$ROOT_DIR/docs/pm2-version.txt" 2>&1 || true
  $SSH "$HOST" "docker --version" > "$ROOT_DIR/docs/docker-version.txt" 2>&1 || true
  $SSH "$HOST" "ufw status" > "$ROOT_DIR/docs/ufw-status.txt" 2>&1 || true
  $SSH "$HOST" "iptables-save" > "$ROOT_DIR/docs/iptables-save.txt" 2>&1 || true
  $SSH "$HOST" "ss -ltnp || netstat -ltnp" > "$ROOT_DIR/docs/ports.txt" 2>&1 || true
  $SSH "$HOST" "dpkg -l || rpm -qa" > "$ROOT_DIR/docs/packages.txt" 2>&1 || true
}

pull_www
pull_nginx
pull_letsencrypt
pull_systemd
pull_cron
pull_usr_local_bin
pull_pm2
pull_docker
pull_services_by_name
pull_inventory

log "Full mirror complete under $ROOT_DIR/ and $SECRETS_DIR/"

#!/usr/bin/env bash
# Run on the VM: sudo bash release.sh /tmp/commerce-release.tar.gz
set -euo pipefail
archive=${1:?Pass a release archive}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
release="/opt/commerce/releases/$stamp"
backup="/opt/commerce/backups/$stamp"
install -d -m 755 "$release"
install -d -m 700 "$backup"
tar -xzf "$archive" -C "$release"
cd "$release"
/usr/local/bin/node --check server.js
/usr/local/bin/node --test tests/*.test.js
chown -R commerce:commerce "$release"
cp -a /opt/commerce/app "$backup/app"
systemctl stop commerce
# A stopped writer makes the database-directory copy consistent.
cp -a /var/lib/commerce "$backup/data"
restore() {
  systemctl stop commerce || true
  mv /opt/commerce/app "$release.failed"
  mv "$backup/app" /opt/commerce/app
  systemctl start commerce
}
trap restore ERR
mv /opt/commerce/app "$backup/previous-app"
mv "$release" /opt/commerce/app
systemctl start commerce
healthy=0
for attempt in 1 2 3 4 5; do
  if curl --fail --silent http://127.0.0.1:3100/api/version >/dev/null; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]]
systemctl is-active --quiet commerce
trap - ERR
printf 'Deployment successful. Rollback copy: %s/previous-app\n' "$backup"

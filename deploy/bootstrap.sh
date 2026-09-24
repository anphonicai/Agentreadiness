#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates xz-utils gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
grep ' node-v24.21.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
tar -xJf node-v24.21.0-linux-x64.tar.xz -C /usr/local --strip-components=1
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
id commerce >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/commerce --shell /usr/sbin/nologin commerce
install -d -o commerce -g commerce /opt/commerce/app
install -d -o commerce -g commerce -m 700 /var/lib/commerce
systemctl stop caddy
printf 'Bootstrap complete\n' > /var/lib/commerce-bootstrap-ready

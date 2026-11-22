#!/usr/bin/env bash
# Install the vps-deploy host helper from a reviewed, immutable toolkit checkout.
# Provisioning (users, registries, sudoers, authorized_keys, deployment roots)
# remains an explicit operator step documented in docs/vps-deployment.md.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "vps-deploy install must run as root" >&2
  exit 1
fi

source_root=${1:-}
if [[ -z ${source_root} || ! -f ${source_root}/package-lock.json || ! -f ${source_root}/scripts/vps-deploy-host.mjs ]]; then
  echo "usage: install-vps-deploy.sh <verified-toolkit-checkout>" >&2
  exit 2
fi

node_major=$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')
if [[ ${node_major} != 22 ]]; then
  echo "Node.js 22 is required at /usr/bin/node" >&2
  exit 10
fi
if ! /usr/bin/docker compose version >/dev/null 2>&1; then
  echo "Docker Engine with the Compose v2 plugin is required" >&2
  exit 10
fi
if [[ ! -f /opt/runtime-secrets/scripts/runtime-secrets.mjs ]]; then
  echo "warning: the DEVOPS-007 runtime-secrets helper is not installed; stacks with runtimeSecrets cannot deploy" >&2
fi

install -d -o root -g root -m 0755 /opt/vps-deploy /opt/vps-deploy/bin /opt/vps-deploy/scripts \
  /opt/vps-deploy/scripts/vps-deploy /opt/vps-deploy/scripts/runtime-secrets
install -o root -g root -m 0644 "${source_root}/scripts/vps-deploy-host.mjs" "${source_root}/scripts/docker-publish.mjs" /opt/vps-deploy/scripts/
install -o root -g root -m 0644 "${source_root}"/scripts/vps-deploy/*.mjs /opt/vps-deploy/scripts/vps-deploy/
install -o root -g root -m 0644 "${source_root}"/scripts/runtime-secrets/*.mjs /opt/vps-deploy/scripts/runtime-secrets/
install -o root -g root -m 0755 "${source_root}/scripts/vps-deploy-ssh.sh" /opt/vps-deploy/bin/vps-deploy-ssh
install -o root -g root -m 0644 "${source_root}/package.json" "${source_root}/package-lock.json" /opt/vps-deploy/
(cd /opt/vps-deploy && /usr/bin/npm ci --omit=dev --ignore-scripts)

install -d -o root -g root -m 0755 /etc/vps-deploy /etc/vps-deploy/stacks
install -o root -g root -m 0644 "${source_root}/systemd/vps-deploy-stack@.service" /etc/systemd/system/
/usr/bin/systemctl daemon-reload

echo "Installed vps-deploy. Register stacks, deploy users, sudoers rules and keys before the first deployment."

#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "runtime-secrets install must run as root" >&2
  exit 1
fi

source_root=${1:-}
if [[ -z ${source_root} || ! -f ${source_root}/package-lock.json || ! -f ${source_root}/scripts/runtime-secrets.mjs ]]; then
  echo "usage: install-runtime-secrets.sh <verified-toolkit-checkout>" >&2
  exit 2
fi

node_major=$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')
if [[ ${node_major} != 22 ]]; then
  echo "Node.js 22 is required" >&2
  exit 10
fi

doppler_version=$(/usr/local/bin/doppler --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
if [[ ${doppler_version} != 3.77.0 ]]; then
  echo "Doppler CLI 3.77.0 must be installed and signature/checksum verified" >&2
  exit 10
fi

install -d -o root -g root -m 0755 /opt/runtime-secrets/scripts/runtime-secrets
install -o root -g root -m 0755 "${source_root}/scripts/runtime-secrets.mjs" /opt/runtime-secrets/scripts/runtime-secrets.mjs
install -o root -g root -m 0644 "${source_root}"/scripts/runtime-secrets/*.mjs /opt/runtime-secrets/scripts/runtime-secrets/
install -o root -g root -m 0644 "${source_root}/package.json" "${source_root}/package-lock.json" /opt/runtime-secrets/
(cd /opt/runtime-secrets && /usr/bin/npm ci --omit=dev --ignore-scripts)

install -d -o root -g root -m 0755 /etc/runtime-secrets/instances /etc/runtime-secrets/manifests
install -o root -g root -m 0644 "${source_root}"/systemd/*.service /etc/systemd/system/
install -o root -g root -m 0644 "${source_root}/systemd/runtime-secrets-tmpfs.mount" \
  '/etc/systemd/system/run-runtime\x2dsecrets.mount'
/usr/bin/systemctl daemon-reload

echo "Installed runtime-secrets helper. Provision service identities and instance files before enabling units."

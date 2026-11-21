#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verification_root=$(mktemp -d)
cleanup() { rm -rf -- "${verification_root}"; }
trap cleanup EXIT

install -m 0644 "${repository_root}"/systemd/*.service "${verification_root}/"
install -m 0644 "${repository_root}/systemd/runtime-secrets-tmpfs.mount" \
  "${verification_root}/run-runtime\\x2dsecrets.mount"

SYSTEMD_UNIT_PATH="${verification_root}:/etc/systemd/system:/run/systemd/system:/usr/local/lib/systemd/system:/lib/systemd/system:/usr/lib/systemd/system" systemd-analyze verify \
  "${verification_root}"/*.service "${verification_root}/run-runtime\\x2dsecrets.mount"

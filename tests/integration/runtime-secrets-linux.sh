#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo "Linux integration checks require Linux" >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo; tests exercise real ownership and mount isolation" >&2
  exit 2
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${repository_root}"
alpine_image='alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'

npm run test:runtime-secrets:linux
npm run validate:systemd

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  work=$(mktemp -d /run/runtime-secrets-integration.XXXXXX)
  chmod 0711 "${work}"
  cleanup() {
    mountpoint -q "${work}/reboot-tmpfs" && umount "${work}/reboot-tmpfs" || true
    rm -rf -- "${work}"
  }
  trap cleanup EXIT

  install -d -o 31001 -g 31001 -m 0700 "${work}/service-a"
  install -d -o 31002 -g 31002 -m 0700 "${work}/service-b"
  printf '%s' 'service-a-synthetic' > "${work}/service-a/ONLY_A"
  chown 31001:31001 "${work}/service-a/ONLY_A"
  chmod 0440 "${work}/service-a/ONLY_A"
  setpriv --reuid 31001 --regid 31001 --clear-groups cat "${work}/service-a/ONLY_A" >/dev/null
  if setpriv --reuid 31002 --regid 31002 --clear-groups cat "${work}/service-a/ONLY_A" >/dev/null 2>&1; then
    echo "cross-service identity read unexpectedly succeeded" >&2
    exit 1
  fi

  install -d -m 0755 "${work}/reboot-tmpfs"
  mount -t tmpfs -o nodev,nosuid,noexec,size=1M tmpfs "${work}/reboot-tmpfs"
  printf '%s' 'ephemeral' > "${work}/reboot-tmpfs/value"
  umount "${work}/reboot-tmpfs"
  mount -t tmpfs -o nodev,nosuid,noexec,size=1M tmpfs "${work}/reboot-tmpfs"
  [[ ! -e "${work}/reboot-tmpfs/value" ]]
  umount "${work}/reboot-tmpfs"

  install -d -m 0550 "${work}/gen-a" "${work}/gen-b"
  printf '%s' 'synthetic-not-a-credential' > "${work}/gen-a/TEST_SECRET"
  printf '%s' 'replacement-synthetic-value' > "${work}/gen-b/TEST_SECRET"
  chown -R 31001:31001 "${work}/gen-a" "${work}/gen-b"
  chmod 0440 "${work}"/gen-*/TEST_SECRET
  ln -s gen-a "${work}/current"
  container=$(docker run -d --rm --read-only --user 31001:31001 --mount "type=bind,src=${work}/current,dst=/run/secrets/app,readonly" "${alpine_image}" sleep 60)
  trap 'docker rm -f "${container}" >/dev/null 2>&1 || true; cleanup' EXIT
  inspect=$(docker inspect "${container}")
  if grep -qE 'synthetic-not-a-credential|replacement-synthetic-value|DOPPLER_TOKEN' <<<"${inspect}"; then
    echo "docker inspect exposed a value or token marker" >&2
    exit 1
  fi
  before=$(docker exec "${container}" cat /run/secrets/app/TEST_SECRET)
  ln -s gen-b "${work}/next"
  mv -Tf "${work}/next" "${work}/current"
  after=$(docker exec "${container}" cat /run/secrets/app/TEST_SECRET)
  [[ ${before} == synthetic-not-a-credential && ${after} == synthetic-not-a-credential ]]
  docker rm -f "${container}" >/dev/null
  recreated=$(docker run --rm --read-only --user 31001:31001 --mount "type=bind,src=${work}/current,dst=/run/secrets/app,readonly" "${alpine_image}" cat /run/secrets/app/TEST_SECRET)
  [[ ${recreated} == replacement-synthetic-value ]]
else
  echo "Docker checks not run: a usable Docker daemon is required" >&2
  exit 3
fi

echo "Linux identities, tmpfs loss, systemd static, Docker inspect, and recreation checks passed"

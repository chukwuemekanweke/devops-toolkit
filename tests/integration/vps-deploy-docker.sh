#!/usr/bin/env bash
# Run the privileged vps-deploy Linux integration harness in a disposable
# Docker-in-Docker host. Requires a Docker daemon that permits --privileged.
# Exit status is non-zero when any check fails or cannot run; nothing is skipped.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # keep container paths intact when launched from Git Bash on Windows

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dind_image='docker@sha256:4bbc7223f81db790097c6dea42fb93e05b8fead4f0431fbe6ccaba6e8473201c' # docker:29-dind
name="vps-deploy-itest-$$"

cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The registry mirror lets digest references under docker.io resolve from a
# local registry, so the real engine pulls by digest without Docker Hub access.
docker run -d --privileged --name "${name}" "${dind_image}" \
  dockerd --registry-mirror http://127.0.0.1:5000 --insecure-registry 127.0.0.1:5000 >/dev/null
tar -C "${repository_root}" --exclude=node_modules --exclude=.git -cf - . \
  | docker exec -i "${name}" sh -c 'mkdir -p /work && tar -xf - -C /work'
# Normalize line endings when launched from a Windows working tree (no-op for Linux checkouts).
docker exec "${name}" sh -c "find /work -type f ! -path '*/node_modules/*' -exec sed -i 's/\r\$//' {} +"
docker exec "${name}" sh /work/tests/integration/vps-deploy-linux.sh

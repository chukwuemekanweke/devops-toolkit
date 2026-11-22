#!/usr/bin/env bash
# Boot-ordering harness: boots a disposable systemd container, provisions a
# secret-bearing stack with the real DEVOPS-007 and vps-deploy units, and
# "reboots" it by restarting the container (which discards the runtime tmpfs).
# Requires a Docker daemon that permits --privileged and host cgroup namespaces.
set -euo pipefail
export MSYS_NO_PATHCONV=1

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=vps-deploy-systemd-itest
name="vps-deploy-systemd-$$"
cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tar -C "${repository_root}" --exclude=node_modules --exclude=.git -cf - . \
  | docker build -q -t "${image}" -f tests/integration/vps-deploy-systemd.Dockerfile - >/dev/null
docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock --name "${name}" "${image}" >/dev/null

in_host() { docker exec "${name}" "$@"; }
wait_boot() {
  for _ in $(seq 1 90); do
    state=$(in_host systemctl is-system-running 2>/dev/null || true)
    case "${state}" in running|degraded) return 0 ;; esac
    sleep 1
  done
  echo "systemd did not finish booting (state: ${state:-unknown})" >&2
  in_host systemctl --failed --no-pager >&2 || true
  exit 1
}
reboot_host() { docker restart -t 20 "${name}" >/dev/null; wait_boot; }
property() { in_host systemctl show -p "$2" --value "$1"; }
fail() { echo "FAILED: $*" >&2; in_host journalctl -b --no-pager -u 'runtime-secrets-*' -u 'vps-deploy-stack@*' | tail -n 40 >&2 || true; exit 1; }
pass() { echo "- $* ... ok"; }

wait_boot
in_host bash /work/tests/integration/vps-deploy-systemd-setup.sh >/dev/null
in_host bash -c 'cd /etc/systemd/system && systemd-analyze verify vps-deploy-stack@itsd-backend.service' \
  || fail "systemd-analyze verify rejected the stack unit"
pass "stack unit and generated boot drop-in pass systemd-analyze verify"
in_host bash /work/scripts/validate-runtime-secrets-systemd.sh || fail "repository systemd units failed static verification"
pass "all repository systemd units pass the DEVOPS-007 static verification script"

in_host touch /etc/doppler-stub/unavailable
reboot_host
[[ $(property runtime-secrets-initialize@itsd-api.service ActiveState) == failed ]] || fail "initializer did not fail with Doppler unavailable"
[[ $(property runtime-secrets-render@itsd-api.service ExecMainStatus) == 21 ]] || fail "render did not fail with the provider category (it may have crashed instead)"
[[ $(property vps-deploy-stack@itsd-backend.service ActiveState) != active ]] || fail "stack started without runtime secrets"
in_host test ! -e /var/lib/itest/stack-started || fail "stack ExecStart ran without runtime secrets"
in_host test ! -e /run/runtime-secrets/itsd-backend/prd/api/current || fail "a current generation exists after failed boot"
[[ $(property vps-deploy-stack@itsd-backend.service Result) == dependency || $(property vps-deploy-stack@itsd-backend.service ActiveState) == inactive ]] \
  || fail "stack unit was not held back by its dependency"
pass "reboot with Doppler unavailable keeps the secret-bearing stack stopped (fail closed)"

in_host rm -f /etc/doppler-stub/unavailable
reboot_host
[[ $(property runtime-secrets-initialize@itsd-api.service ActiveState) == active ]] || fail "initializer did not succeed with Doppler available"
[[ $(property vps-deploy-stack@itsd-backend.service ActiveState) == active ]] || fail "stack did not start after successful initialization"
in_host test -s /var/lib/itest/stack-started || fail "stack ExecStart did not run"
current=$(in_host readlink /run/runtime-secrets/itsd-backend/prd/api/current) || fail "no current generation"
[[ ${current} =~ ^gen-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || fail "unexpected current pointer ${current}"
[[ $(in_host stat -c '%a %U:%G' "/run/runtime-secrets/itsd-backend/prd/api/${current}/API__KEY") == "440 rsec-itsd-api:rsec-itsd-api" ]] \
  || fail "rendered key file has unexpected mode or ownership"
initializer_done=$(property runtime-secrets-initialize@itsd-api.service ExecMainExitTimestampMonotonic)
stack_started=$(property vps-deploy-stack@itsd-backend.service ExecMainStartTimestampMonotonic)
(( stack_started >= initializer_done )) || fail "stack started before runtime-secret initialization finished"
pass "boot renders and activates secrets before the stack starts"

in_host touch /etc/doppler-stub/unavailable
in_host systemctl start runtime-secrets-render@itsd-api.service && fail "refresh unexpectedly succeeded during outage"
[[ $(property vps-deploy-stack@itsd-backend.service ActiveState) == active ]] || fail "refresh outage stopped the running stack"
[[ $(in_host readlink /run/runtime-secrets/itsd-backend/prd/api/current) == "${current}" ]] || fail "refresh outage changed current"
pass "Doppler outage during refresh leaves the running stack and current generation untouched"

echo "vps-deploy systemd boot-ordering checks passed"

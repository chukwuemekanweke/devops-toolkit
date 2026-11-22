#!/bin/bash
# SSH forced command for the vps-deploy account. Install one authorized_keys
# line per application deploy key, binding that key to exactly one stack:
#
#   restrict,command="/opt/vps-deploy/bin/vps-deploy-ssh example-backend-production" ssh-ed25519 AAAA... deploy-example-backend
#
# The client may request only the fixed operation "deploy". The request body is
# read from stdin by the root helper, which validates it against the root-owned
# registry for the bound stack. No client-supplied text reaches a shell.
set -euo pipefail
umask 077

reject() {
  printf '{"ok":false,"status":"failed","failure":{"category":"usage","message":"%s"}}\n' "$1"
  exit 2
}

[[ $# -eq 1 ]] || reject "deploy key is not bound to exactly one stack"
stack=$1
[[ ${stack} =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || reject "deploy key stack binding is invalid"
[[ ${SSH_ORIGINAL_COMMAND:-} == "deploy" ]] || reject "only the deploy operation is permitted"

exec /usr/bin/sudo -n /usr/bin/node /opt/vps-deploy/scripts/vps-deploy-host.mjs deploy --stack "${stack}"

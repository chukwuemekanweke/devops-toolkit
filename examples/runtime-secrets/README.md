# Runtime secret delivery example

This application-owned example declares one service without embedding values. Install the instance
configuration as `/etc/runtime-secrets/instances/example-backend-prd-webapi.json` and the key manifest
as `/etc/runtime-secrets/manifests/example-backend-webapi.json`. Replace UID/GID values with identities
created during host provisioning.

`compose.yaml` mounts only the resolved `current` generation. `create_host_path: false` makes a missing
generation fail closed. Secret-bearing services use `restart: "no"`; the boot integration unit renders,
activates, and then starts the stack. A newly activated generation takes effect only after container
recreation, not `docker compose restart`.

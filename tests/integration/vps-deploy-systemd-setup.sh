#!/usr/bin/env bash
# Provision one secret-bearing stack inside the disposable systemd host using the
# real DEVOPS-007 and vps-deploy installers, units and generated boot drop-in.
# Docker itself is not available here: docker.service is a stand-in unit and the
# stack unit's ExecStart is replaced with a marker so only boot ordering is tested.
set -euo pipefail

printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v3.77.0"; exit 0; fi\n[ "$*" = "secrets download --no-file --no-fallback --format json" ] || exit 64\n[ -f /etc/doppler-stub/unavailable ] && { echo "Unable to reach Doppler: connection refused" >&2; exit 1; }\ncat "/etc/doppler-stub/$DOPPLER_TOKEN.json"\n' > /usr/local/bin/doppler
chmod 0755 /usr/local/bin/doppler
printf '#!/bin/sh\n[ "$1 $2" = "compose version" ] && exit 0\nexit 1\n' > /usr/bin/docker
chmod 0755 /usr/bin/docker
printf '[Unit]\nDescription=Stand-in Docker daemon for boot-ordering tests\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/docker.service

bash /work/scripts/install-runtime-secrets.sh /work >/dev/null
bash /work/scripts/install-vps-deploy.sh /work >/dev/null

groupadd --gid 21001 rsec-itsd-api
useradd --system --no-create-home --shell /usr/sbin/nologin --gid 21001 rsec-itsd-api
install -o root -g root -m 0644 /dev/stdin /etc/runtime-secrets/manifests/itsd-api.json <<'JSON'
{"version":1,"secrets":[{"name":"API__KEY","required":true,"allowEmpty":false,"maxBytes":256}]}
JSON
install -o root -g root -m 0644 /dev/stdin /etc/runtime-secrets/instances/itsd-api.json <<'JSON'
{"version":1,"application":"itsd-backend","environment":"prd","service":"api","expectedDopplerProject":"itsd-backend","expectedDopplerConfig":"prd_api","outputDirectory":"/run/runtime-secrets/itsd-backend/prd/api","serviceGroupId":21001,"keyManifestPath":"/etc/runtime-secrets/manifests/itsd-api.json","providerRetries":0,"providerTimeoutSeconds":10}
JSON
install -d -o root -g root -m 0755 /etc/doppler-stub
install -o root -g root -m 0644 /dev/stdin /etc/doppler-stub/tok-api.json <<'JSON'
{"DOPPLER_PROJECT":"itsd-backend","DOPPLER_CONFIG":"prd_api","DOPPLER_ENVIRONMENT":"prd","API__KEY":"systemd-synthetic-value"}
JSON
install -o root -g root -m 0644 /dev/stdin /etc/tmpfiles.d/runtime-secrets-itsd-api.conf <<'CONF'
d /run/runtime-secrets/itsd-backend 0711 root root -
d /run/runtime-secrets/itsd-backend/prd 0711 root root -
d /run/runtime-secrets/itsd-backend/prd/api 0700 rsec-itsd-api rsec-itsd-api -
CONF
install -d -o root -g root -m 0700 /etc/credstore.encrypted
printf 'tok-api' | systemd-creds encrypt --with-key=host --name=doppler-token - /etc/credstore.encrypted/runtime-secrets-itsd-api.token
chmod 0400 /etc/credstore.encrypted/runtime-secrets-itsd-api.token
for operation in render activate discard restore; do
  install -d -m 0755 "/etc/systemd/system/runtime-secrets-${operation}@itsd-api.service.d"
  printf '[Service]\nReadWritePaths=\nReadWritePaths=/run/runtime-secrets/itsd-backend/prd/api\n' > "/etc/systemd/system/runtime-secrets-${operation}@itsd-api.service.d/paths.conf"
done

install -d -o root -g root -m 0750 /srv/itsd-backend/production
install -o root -g root -m 0644 /dev/stdin /etc/vps-deploy/stacks/itsd-backend.json <<'JSON'
{"version":1,"stackName":"itsd-backend","environment":"production","deploymentPath":"/srv/itsd-backend/production","allowedSourceRepositories":["itest/backend"],"allowedImageRepositories":["docker.io/itest/"],"runtimeSecrets":{"services":{"api":{"instance":"itsd-api"},"migrator":{"instance":"itsd-mig","startAtBoot":false}}}}
JSON
install -d -m 0755 /etc/systemd/system/vps-deploy-stack@itsd-backend.service.d
node /opt/vps-deploy/scripts/vps-deploy-host.mjs boot-dropin --stack itsd-backend > /etc/systemd/system/vps-deploy-stack@itsd-backend.service.d/runtime-secrets.conf
install -d -m 0755 /var/lib/itest
printf '[Service]\nExecStart=\nExecStart=/bin/sh -c "date -u +%%%%s >> /var/lib/itest/stack-started"\nExecStop=\n' > /etc/systemd/system/vps-deploy-stack@itsd-backend.service.d/zz-itest-marker.conf

systemctl daemon-reload
systemctl enable 'run-runtime\x2dsecrets.mount' docker.service vps-deploy-stack@itsd-backend.service
cat /etc/systemd/system/vps-deploy-stack@itsd-backend.service.d/runtime-secrets.conf

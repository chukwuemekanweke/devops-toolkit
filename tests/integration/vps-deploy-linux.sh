#!/bin/sh
# Inner vps-deploy harness. Runs as root on a disposable Linux Docker host whose
# daemon uses http://127.0.0.1:5000 as a docker.io registry mirror (see
# vps-deploy-docker.sh). Do not run it on a real server: it installs packages,
# creates users and sudoers rules, and mounts tmpfs under /run.
set -eu

if [ "$(uname -s)" != Linux ] || [ "$(id -u)" -ne 0 ]; then
  echo "vps-deploy integration requires root on Linux" >&2
  exit 2
fi

for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable; integration checks did not run" >&2; exit 3; }

apk add --no-cache -q bash openssh-server openssh-client sudo util-linux libstdc++ >/dev/null

node_image='node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a' # node:22-alpine
busybox_image='busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec' # busybox:1.37
registry_image='registry@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c' # registry:3

# Node.js 22 from the pinned official image (musl build for this Alpine host).
docker create --name node22 "${node_image}" >/dev/null
docker cp node22:/usr/local/bin/node /usr/bin/node
docker cp node22:/usr/local/lib/node_modules /usr/local/lib/
docker rm node22 >/dev/null
ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm
ln -sf /usr/local/bin/docker /usr/bin/docker
node --version
cd /work && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null

docker run -d --name itest-registry -p 127.0.0.1:5000:5000 "${registry_image}" >/dev/null
for _ in $(seq 1 30); do wget -q -O /dev/null http://127.0.0.1:5000/v2/ && break; sleep 1; done

mkdir -p /itest/images
build() {
  name=$1; tag=$2; shift 2
  directory=/itest/images/${name}-${tag}
  mkdir -p "${directory}"
  printf '%s\n' "$@" > "${directory}/Dockerfile"
  docker build -q -t "127.0.0.1:5000/itest/${name}:${tag}" "${directory}" >/dev/null
  digest=$(docker push "127.0.0.1:5000/itest/${name}:${tag}" | grep -o 'sha256:[0-9a-f]\{64\}' | tail -n1)
  docker rmi -f "127.0.0.1:5000/itest/${name}:${tag}" >/dev/null
  printf '"%s-%s":"%s",' "${name}" "${tag}" "${digest}" >> /itest/digests.partial
}
: > /itest/digests.partial
for version in v1 v2; do
  build app "${version}" "FROM ${busybox_image}" "RUN mkdir /www && echo ok > /www/health && echo ${version} > /www/version" \
    "USER 10001" 'CMD ["httpd","-f","-p","8080","-h","/www"]'
done
build app v3 "FROM ${busybox_image}" "RUN mkdir /www && echo v3 > /www/version" "USER 10001" 'CMD ["httpd","-f","-p","8080","-h","/www"]'
build migrator v1 "FROM ${busybox_image}" "USER 10001" \
  'ENTRYPOINT ["sh","-c","sleep ${MIGRATION_SLEEP:-0}; test -r /run/secrets/app/DB__OWNER || exit 7; exit ${MIGRATION_EXIT:-0}"]'
build root v1 "FROM ${busybox_image}" 'CMD ["sleep","3600"]'
printf '{%s}\n' "$(sed 's/,$//' /itest/digests.partial)" > /itest/digests.json

# Constrained SSH deploy interface: forced command, sudoers, host helper install.
# This Alpine Docker host has no systemd; the installer's daemon-reload is stubbed
# here. Real unit behavior is exercised by tests/integration/vps-deploy-systemd.sh.
printf '#!/bin/sh\nexit 0\n' > /usr/bin/systemctl && chmod 0755 /usr/bin/systemctl
mkdir -p /etc/systemd/system
bash /work/scripts/install-vps-deploy.sh /work
adduser -D -s /bin/sh vps-deploy
sed -i 's/^vps-deploy:!:/vps-deploy:*:/' /etc/shadow
ssh-keygen -A >/dev/null
mkdir -p /itest/ssh && chmod 0700 /itest/ssh
for stack in itest-frontend itest-backend; do
  ssh-keygen -q -t ed25519 -N '' -C "deploy-${stack}" -f "/itest/ssh/${stack}"
done
install -d -o vps-deploy -g vps-deploy -m 0700 /home/vps-deploy/.ssh
{
  printf 'restrict,command="/opt/vps-deploy/bin/vps-deploy-ssh itest-frontend" %s\n' "$(cat /itest/ssh/itest-frontend.pub)"
  printf 'restrict,command="/opt/vps-deploy/bin/vps-deploy-ssh itest-backend" %s\n' "$(cat /itest/ssh/itest-backend.pub)"
} > /home/vps-deploy/.ssh/authorized_keys
chown vps-deploy:vps-deploy /home/vps-deploy/.ssh/authorized_keys && chmod 0600 /home/vps-deploy/.ssh/authorized_keys
printf '[127.0.0.1]:2222 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > /itest/ssh/known_hosts
ssh-keygen -q -t ed25519 -N '' -f /itest/ssh/impostor
printf '[127.0.0.1]:2222 %s\n' "$(cut -d' ' -f1,2 /itest/ssh/impostor.pub)" > /itest/ssh/wrong_known_hosts
grep -q '^@includedir /etc/sudoers.d' /etc/sudoers || echo '@includedir /etc/sudoers.d' >> /etc/sudoers
{
  grep '^Defaults' /work/systemd/vps-deploy-operator.sudoers
  for stack in itest-frontend itest-backend; do
    grep '^vps-deploy ' /work/systemd/vps-deploy-operator.sudoers | sed "s/STACK\$/${stack}/"
  done
} > /etc/sudoers.d/vps-deploy
chmod 0440 /etc/sudoers.d/vps-deploy
visudo -cf /etc/sudoers.d/vps-deploy >/dev/null
/usr/sbin/sshd -p 2222 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no \
  -o AllowUsers=vps-deploy -o AllowTcpForwarding=no -o X11Forwarding=no -o PermitTTY=no

node /work/tests/integration/vps-deploy-integration.mjs

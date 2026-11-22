# Disposable systemd host (Debian 12, systemd 252) for boot-ordering tests.
# Build context: a toolkit checkout streamed by vps-deploy-systemd.sh.
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS node
# node:22-bookworm-slim

FROM debian@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8
# debian:12
ENV container=docker
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus util-linux ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask systemd-logind.service getty.target console-getty.service systemd-firstboot.service
COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm
COPY . /work
# Normalize line endings when built from a Windows working tree (no-op for Linux checkouts).
RUN find /work -type f -exec sed -i 's/\r$//' {} +
STOPSIGNAL SIGRTMIN+3
# A real host's systemd runs with shared mount propagation; Docker defaults to
# private, which hides systemd's per-unit credential mounts from services.
CMD ["/bin/sh", "-c", "mount --make-rshared / && exec /lib/systemd/systemd"]

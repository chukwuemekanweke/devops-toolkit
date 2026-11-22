// Host-side Docker Compose policy. Application repositories own Compose files,
// but those files are executed by a root-equivalent Docker daemon, so the host
// rejects constructs that escape the stack boundary before any container change.
import { posix } from "node:path";
import { fail, isRecord, printable } from "./contract.mjs";

export const runtimeSecretTarget = "/run/secrets/app";
export const generationLabel = "io.github.devops-toolkit.runtime-secrets.generation";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const forbiddenSecurityOptions = /(?:unconfined|label[:=]disable|systempaths)/iu;
const pinnedImage = /@sha256:[0-9a-f]{64}$/u;
const rootUsers = /^(?:|0|root)(?::.*)?$/u;

function reject(message) {
  fail("compose-policy", message);
}

/**
 * Parse each application Compose file before Docker Compose reads it. Compose
 * evaluates include/env_file/extends-file references as the host user, so they
 * are rejected outright: only the transferred files define the stack.
 */
export async function prescanComposeFiles(files, { parseDocument } = {}) {
  const parse = parseDocument ?? (await import("yaml")).parseDocument;
  for (const file of files) {
    const document = parse(file.content, { strict: true, uniqueKeys: true, version: "1.2", prettyErrors: false });
    if (document.errors.length > 0) reject(`${file.path}: invalid YAML (${printable(document.errors[0].message)})`);
    let value;
    try { value = document.toJS({ maxAliasCount: 100 }); } catch (error) { reject(`${file.path}: invalid YAML (${printable(error.message)})`); }
    if (!isRecord(value)) reject(`${file.path}: Compose document root must be a mapping`);
    if (Object.hasOwn(value, "include")) reject(`${file.path}: top-level 'include' is not permitted; list every Compose file in compose-files`);
    for (const [name, service] of Object.entries(isRecord(value.services) ? value.services : {})) {
      if (!isRecord(service)) continue;
      if (Object.hasOwn(service, "env_file")) reject(`${file.path}: service '${printable(name)}' uses env_file; non-secret values belong in the Compose file or the host stack.env`);
      if (isRecord(service.extends) && Object.hasOwn(service.extends, "file")) reject(`${file.path}: service '${printable(name)}' extends another file`);
    }
    for (const section of ["configs", "secrets"]) {
      for (const [name, entry] of Object.entries(isRecord(value[section]) ? value[section] : {})) {
        if (isRecord(entry) && Object.hasOwn(entry, "file")) reject(`${file.path}: top-level ${section}.${printable(name)} reads a host file; use inline content or a registry-approved bind`);
      }
    }
  }
}

/**
 * Validate the fully merged and interpolated Compose model produced by
 * `docker compose config --format json` with every profile enabled.
 *
 * context:
 *   componentServices: Map<service, { reference }>
 *   secretServices:    Map<service, { bindSource }>
 *   migrationService:  string
 *   registry:          normalized host stack registry
 */
export function validateMergedConfig(config, context) {
  if (!isRecord(config) || !isRecord(config.services)) reject("merged Compose configuration has no services");
  const services = config.services;
  const names = new Set(Object.keys(services));
  for (const [service] of context.componentServices) {
    if (!names.has(service)) reject(`release component service '${service}' is not defined by the Compose configuration`);
  }
  for (const [service] of context.secretServices) {
    if (!names.has(service)) reject(`registered secret-bearing service '${service}' is not defined by the Compose configuration`);
  }
  if (context.migrationService && !names.has(context.migrationService)) reject(`migration-service '${context.migrationService}' is not defined by the Compose configuration`);
  for (const [name, definition] of Object.entries(services)) {
    validateService(name, definition, context, names);
  }
  validateNetworks(config.networks, context.registry);
  validateVolumes(config.volumes, context.registry);
  for (const section of ["configs", "secrets"]) {
    for (const [name, entry] of Object.entries(isRecord(config[section]) ? config[section] : {})) {
      if (isRecord(entry) && entry.file !== undefined) reject(`top-level ${section}.${name} reads a host file`);
    }
  }
}

function validateService(name, definition, context, names) {
  if (!isRecord(definition)) reject(`service '${name}' has an invalid definition`);
  const label = `service '${name}'`;
  const component = context.componentServices.get(name);
  if (typeof definition.image !== "string" || definition.image.length === 0) reject(`${label} must declare an image`);
  if (component) {
    if (definition.image !== component.reference) reject(`${label} image does not resolve to the release digest`);
  } else if (!pinnedImage.test(definition.image)) {
    reject(`${label} image must be pinned by sha256 digest; mutable tags are not deployment authority`);
  }
  if (definition.privileged === true) reject(`${label} must not be privileged`);
  if (definition.container_name !== undefined) reject(`${label} must not set container_name; stacks are isolated by project name`);
  for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup"]) {
    const value = definition[key];
    if (typeof value === "string" && (value === "host" || value.startsWith("container:"))) reject(`${label} must not share the host or another container's ${key} namespace`);
  }
  if (typeof definition.network_mode === "string") {
    const mode = definition.network_mode;
    if (mode === "host" || mode.startsWith("container:")) reject(`${label} must not use network_mode ${printable(mode)}`);
    if (mode.startsWith("service:") && !names.has(mode.slice("service:".length))) reject(`${label} network_mode references an unknown service`);
  }
  for (const key of ["volumes_from", "external_links", "devices", "device_cgroup_rules"]) {
    if (Array.isArray(definition[key]) ? definition[key].length > 0 : definition[key] !== undefined) reject(`${label} must not use ${key}`);
  }
  if (definition.cgroup_parent !== undefined) reject(`${label} must not set cgroup_parent`);
  const capabilities = Array.isArray(definition.cap_add) ? definition.cap_add : [];
  for (const capability of capabilities) {
    const normalized = String(capability).toUpperCase().replace(/^CAP_/u, "");
    if (normalized === "ALL" || !context.registry.allowedCapabilities.includes(normalized)) reject(`${label} adds capability ${printable(capability)} that the host registry does not allow`);
  }
  const securityOptions = Array.isArray(definition.security_opt) ? definition.security_opt.map(String) : [];
  if (securityOptions.some((option) => forbiddenSecurityOptions.test(option))) reject(`${label} disables a kernel security profile`);
  validatePorts(label, definition.ports, context.registry);
  validateMounts(name, label, definition.volumes, context);
  const secret = context.secretServices.get(name);
  if (secret) {
    if (definition.restart !== undefined && definition.restart !== "no") reject(`${label} holds runtime secrets and must use restart: "no" so Docker cannot bypass fail-closed boot initialization`);
    if (!securityOptions.some((option) => /^no-new-privileges(?:[:=]true)?$/u.test(option))) reject(`${label} holds runtime secrets and must set security_opt no-new-privileges:true`);
  }
  if (name === context.migrationService) {
    if (definition.restart === "always" || definition.restart === "unless-stopped") reject(`${label} is the one-shot migration service and must not use a restart-forever policy`);
  } else if (context.migrationService && isRecord(definition.depends_on) && Object.hasOwn(definition.depends_on, context.migrationService)) {
    reject(`${label} depends on migration-service '${context.migrationService}'; the deployment workflow orders migration before rollout, so long-running services must not start it`);
  }
}

function validatePorts(label, ports, registry) {
  if (ports === undefined) return;
  if (!Array.isArray(ports)) reject(`${label} has an invalid ports definition`);
  for (const port of ports) {
    if (!isRecord(port)) reject(`${label} has an invalid port entry`);
    if (port.published === undefined || port.published === null || port.published === "") continue;
    const hostIp = typeof port.host_ip === "string" ? port.host_ip : "";
    if (isLoopback(hostIp)) continue;
    const published = String(port.published);
    if (!/^\d{1,5}$/u.test(published) || !registry.publicPorts.includes(Number(published))) {
      reject(`${label} publishes port ${printable(published)} on a non-loopback interface; bind to 127.0.0.1 or list it in the host registry publicPorts`);
    }
  }
}

function validateMounts(name, label, volumes, context) {
  if (volumes === undefined) {
    if (context.secretServices.has(name)) reject(`${label} must mount its runtime-secret generation at ${runtimeSecretTarget}`);
    return;
  }
  if (!Array.isArray(volumes)) reject(`${label} has an invalid volumes definition`);
  const secret = context.secretServices.get(name);
  let secretMounts = 0;
  for (const mount of volumes) {
    if (!isRecord(mount) || typeof mount.type !== "string") reject(`${label} has an invalid mount`);
    if (mount.target === runtimeSecretTarget && !(mount.type === "bind" && secret && mount.source === secret.bindSource)) {
      reject(`${label} mounts ${runtimeSecretTarget} from a source other than its own runtime-secret generation`);
    }
    if (mount.type === "volume" || mount.type === "tmpfs") continue;
    if (mount.type !== "bind") reject(`${label} uses unsupported mount type ${printable(mount.type)}`);
    const source = typeof mount.source === "string" ? posix.normalize(mount.source) : "";
    if (!source.startsWith("/")) reject(`${label} has a bind mount without an absolute source`);
    if (secret && source === secret.bindSource) {
      if (mount.target !== runtimeSecretTarget) reject(`${label} must mount its runtime secrets at ${runtimeSecretTarget}`);
      if (mount.read_only !== true) reject(`${label} must mount runtime secrets read-only`);
      if (!isRecord(mount.bind) || mount.bind.create_host_path !== false) reject(`${label} must set bind.create_host_path: false for runtime secrets so a missing generation fails closed`);
      secretMounts += 1;
      continue;
    }
    if (source === "/run/runtime-secrets" || source.startsWith("/run/runtime-secrets/")) reject(`${label} mounts runtime secrets that do not belong to it`);
    if (/(?:^|\/)docker\.sock$/u.test(source) || source === "/run/docker" || source === "/var/run/docker") reject(`${label} must not mount the Docker socket`);
    if (!context.registry.allowedBindSources.some((prefix) => source === prefix.slice(0, -1) || source.startsWith(prefix))) {
      reject(`${label} bind-mounts host path ${printable(source)} that the host registry does not allow`);
    }
    if (mount.read_only !== true) reject(`${label} must bind host path ${printable(source)} read-only`);
  }
  if (secret && secretMounts !== 1) reject(`${label} must mount exactly its own runtime-secret generation at ${runtimeSecretTarget}`);
}

function validateNetworks(networks, registry) {
  for (const [name, network] of Object.entries(isRecord(networks) ? networks : {})) {
    if (!isRecord(network)) continue;
    if (network.external === true) {
      if (!registry.allowedExternalNetworks.includes(String(network.name ?? name))) reject(`external network '${printable(network.name ?? name)}' is not allowed by the host registry`);
      continue;
    }
    if (network.driver !== undefined && network.driver !== "bridge") reject(`network '${name}' must use the bridge driver`);
  }
}

function validateVolumes(volumes, registry) {
  for (const [name, volume] of Object.entries(isRecord(volumes) ? volumes : {})) {
    if (!isRecord(volume)) continue;
    if (volume.external === true) {
      if (!registry.allowedExternalVolumes.includes(String(volume.name ?? name))) reject(`external volume '${printable(volume.name ?? name)}' is not allowed by the host registry`);
      continue;
    }
    if (volume.driver !== undefined && volume.driver !== "local") reject(`volume '${name}' must use the local driver`);
    if (isRecord(volume.driver_opts) && Object.keys(volume.driver_opts).length > 0) reject(`volume '${name}' must not set driver_opts (host path binding is not permitted)`);
  }
}

/** Long-running services are default-profile services other than the migration service. */
export function selectLongRunningServices(defaultConfig, migrationService) {
  if (!isRecord(defaultConfig) || !isRecord(defaultConfig.services)) reject("default-profile Compose configuration has no services");
  const services = Object.keys(defaultConfig.services).filter((name) => name !== migrationService).sort();
  if (services.length === 0) reject("the Compose configuration defines no long-running services");
  return services;
}

export function selectHealthServices(requested, longRunning) {
  if (requested.length === 0) return [...longRunning];
  for (const service of requested) {
    if (!longRunning.includes(service)) reject(`health service '${service}' is not a long-running default-profile service`);
  }
  return [...requested];
}

export function isRootUser(user) {
  return rootUsers.test(String(user ?? "").trim());
}

export function isLoopback(host) {
  const value = String(host ?? "").replace(/^\[|\]$/gu, "").toLowerCase();
  return loopbackHosts.has(value) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value);
}

export function imagesOverride(componentServices) {
  const services = {};
  for (const [service, component] of [...componentServices].sort(([a], [b]) => a.localeCompare(b))) {
    services[service] = { image: component.reference };
  }
  return { services };
}

export function generationsOverride(generations) {
  const services = {};
  for (const [service, generation] of Object.entries(generations).sort(([a], [b]) => a.localeCompare(b))) {
    services[service] = { labels: { [generationLabel]: generation } };
  }
  return { services };
}

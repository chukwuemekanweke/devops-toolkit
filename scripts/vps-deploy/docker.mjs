// Docker and Docker Compose adapter. Commands run without a shell, with an
// explicit scrubbed environment, bounded captured output and timeouts. Raw
// command output is never relayed: callers receive exit codes and parsed data.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, isRecord, printable } from "./contract.mjs";

const safePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function runCommand(command, args, { env = {}, input, timeoutMs = 120_000, maxOutput = 4 * 1024 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      env: { PATH: safePath, LANG: "C.UTF-8", ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    child.stdout.on("data", (chunk) => { if (outSize < maxOutput) { stdout.push(chunk); outSize += chunk.length; } });
    child.stderr.on("data", (chunk) => { if (errSize < 64 * 1024) { stderr.push(chunk); errSize += chunk.length; } });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 128));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Single-line, bounded, redacted summary of a command diagnostic for compose validation errors only. */
export function summarizeDiagnostic(text, redactions = []) {
  let line = String(text ?? "").split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  for (const value of redactions) if (value) line = line.split(value).join("[redacted]");
  line = line.replace(/([A-Za-z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Za-z0-9_]*)=\S+/giu, "$1=[redacted]");
  return printable(line).slice(0, 300);
}

export class DockerCompose {
  constructor({ run = runCommand, temporaryRoot = process.platform === "win32" ? tmpdir() : "/run", docker = "docker" } = {}) {
    this.run = run;
    this.temporaryRoot = temporaryRoot;
    this.docker = docker;
    this.dockerConfig = undefined;
  }

  env() {
    return this.dockerConfig ? { DOCKER_CONFIG: this.dockerConfig, HOME: this.dockerConfig } : { HOME: this.temporaryRoot };
  }

  /**
   * Store pull-only registry credentials in a private temporary Docker client
   * configuration (tmpfs under /run on the host). The token never appears in
   * process arguments, environment variables or the root user's persistent
   * Docker configuration, and the directory is removed by `forgetCredentials`.
   */
  async useCredentials({ username, token }) {
    await this.forgetCredentials();
    const directory = await mkdtemp(join(this.temporaryRoot, "vps-deploy-registry-"));
    await chmod(directory, 0o700);
    const auth = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
    await writeFile(join(directory, "config.json"), JSON.stringify({ auths: { "https://index.docker.io/v1/": { auth } } }), { mode: 0o600, flag: "wx" });
    this.dockerConfig = directory;
  }

  async forgetCredentials() {
    if (!this.dockerConfig) return;
    const directory = this.dockerConfig;
    this.dockerConfig = undefined;
    await rm(directory, { recursive: true, force: true });
  }

  async pull(reference) {
    const result = await this.run(this.docker, ["pull", "--quiet", reference], { env: this.env(), timeoutMs: 900_000 });
    return result.code === 0 && !result.timedOut;
  }

  async imageUser(reference) {
    const result = await this.run(this.docker, ["image", "inspect", "--format", "{{json .Config.User}}", reference], { env: this.env() });
    if (result.code !== 0) fail("pull", `image ${printable(reference)} is not available locally after pull`);
    try { return JSON.parse(result.stdout.trim()) ?? ""; } catch { return ""; }
  }

  composeArgs(project) {
    const args = ["compose", "--project-name", project.name, "--project-directory", project.directory];
    if (project.envFile) args.push("--env-file", project.envFile);
    for (const file of project.files) args.push("--file", file);
    return args;
  }

  async config(project, { allProfiles = false } = {}) {
    const args = this.composeArgs(project);
    if (allProfiles) args.splice(1, 0, "--profile", "*");
    const result = await this.run(this.docker, [...args, "config", "--format", "json"], { env: this.env(), timeoutMs: 120_000 });
    if (result.code !== 0 || result.timedOut) {
      fail("compose", `docker compose config rejected the configuration: ${summarizeDiagnostic(result.stderr) || "no diagnostic"}`);
    }
    try { return JSON.parse(result.stdout); } catch { fail("compose", "docker compose config produced unreadable output"); }
  }

  async up(project, services, { pull = "never", removeOrphans = false, timeoutMs = 900_000 } = {}) {
    const args = [...this.composeArgs(project), "up", "--detach", "--no-build", "--pull", pull, "--quiet-pull"];
    if (removeOrphans) args.push("--remove-orphans");
    args.push(...services);
    const result = await this.run(this.docker, args, { env: this.env(), timeoutMs });
    return { ok: result.code === 0 && !result.timedOut, code: result.code, timedOut: result.timedOut, diagnostic: summarizeDiagnostic(result.stderr.split(/\r?\n/u).filter((line) => /error/iu.test(line)).join("\n")) };
  }

  async stop(project, { timeoutMs = 300_000 } = {}) {
    const result = await this.run(this.docker, [...this.composeArgs(project), "stop"], { env: this.env(), timeoutMs });
    return result.code === 0;
  }

  /** Run the one-shot migration service attached; the container is kept for diagnostics until cleanup. */
  async runOneShot(project, service, containerName, { timeoutMs }) {
    const args = [...this.composeArgs(project), "run", "--no-TTY", "--name", containerName, "--quiet-pull", service];
    const result = await this.run(this.docker, args, { env: this.env(), timeoutMs, maxOutput: 1 });
    if (result.timedOut) {
      await this.run(this.docker, ["kill", containerName], { env: this.env(), timeoutMs: 60_000 });
    }
    const inspect = await this.run(this.docker, ["container", "inspect", "--format", "{{json .State}}", containerName], { env: this.env() });
    let state = null;
    if (inspect.code === 0) { try { state = JSON.parse(inspect.stdout); } catch { state = null; } }
    return {
      timedOut: result.timedOut,
      created: state !== null,
      exitCode: state && typeof state.ExitCode === "number" ? state.ExitCode : (result.timedOut ? null : result.code),
      running: Boolean(state?.Running),
    };
  }

  async removeContainer(name) {
    const result = await this.run(this.docker, ["container", "rm", "--force", name], { env: this.env() });
    return result.code === 0;
  }

  async oneShotContainers(projectName, service) {
    const result = await this.run(this.docker, [
      "container", "ls", "--all", "--quiet",
      "--filter", `label=com.docker.compose.project=${projectName}`,
      "--filter", `label=com.docker.compose.service=${service}`,
      "--filter", "label=com.docker.compose.oneoff=True",
    ], { env: this.env() });
    return result.code === 0 ? result.stdout.split(/\s+/u).filter(Boolean) : [];
  }

  /** Container state for a project, normalized from `docker compose ps --format json`. */
  async ps(projectName) {
    const result = await this.run(this.docker, ["compose", "--project-name", projectName, "ps", "--all", "--format", "json"], { env: this.env() });
    if (result.code !== 0) return null;
    return parseComposePs(result.stdout);
  }

  /** Generation labels recorded on every container (running or stopped) of a project. */
  async generationLabels(projectName, label) {
    const result = await this.run(this.docker, [
      "container", "ls", "--all", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--format", `{{.Label "com.docker.compose.service"}} {{.Label "${label}"}}`,
    ], { env: this.env() });
    if (result.code !== 0) return null;
    return result.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter((parts) => parts.length === 2 && parts[1]).map(([service, generation]) => ({ service, generation }));
  }
}

export function parseComposePs(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  let entries;
  if (trimmed.startsWith("[")) {
    entries = JSON.parse(trimmed);
  } else {
    entries = trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
  return entries.filter(isRecord).map((entry) => {
    const labels = typeof entry.Labels === "string" ? entry.Labels : "";
    return {
      id: String(entry.ID ?? ""),
      service: String(entry.Service ?? ""),
      state: String(entry.State ?? "").toLowerCase(),
      health: String(entry.Health ?? "").toLowerCase(),
      exitCode: Number.isInteger(entry.ExitCode) ? entry.ExitCode : null,
      oneOff: /(?:^|,)com\.docker\.compose\.oneoff=True(?:,|$)/u.test(labels),
    };
  });
}

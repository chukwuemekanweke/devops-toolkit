#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadContracts, validatePayload } from "./runtime-secrets/config.mjs";
import { ExitCode, RuntimeSecretsError } from "./runtime-secrets/errors.mjs";
import { retrieveDoppler } from "./runtime-secrets/provider.mjs";
import { GenerationStore } from "./runtime-secrets/store.mjs";

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, instancePath, credentialPath, eligible, generationRoot } = parseArguments(argv);
  const { instance, manifest } = await loadContracts(instancePath, { generationRoot });
  const store = new GenerationStore(instance, dependencies.storeOptions);
  if (command === "render") {
    const payload = await (dependencies.retrieve ?? retrieveDoppler)(instance, { credentialPath });
    return await store.render(validatePayload(payload, instance, manifest));
  }
  if (command === "activate") return await store.activate();
  if (command === "discard") return await store.discard();
  if (command === "restore") return await store.restore();
  if (command === "prune") return await store.prune(eligible);
  return await store.status();
}

function parseArguments(argv) {
  const command = argv[0];
  if (!["render", "activate", "discard", "restore", "prune", "status"].includes(command)) usage();
  let instancePath;
  let credentialPath = process.env.CREDENTIALS_DIRECTORY ? resolve(process.env.CREDENTIALS_DIRECTORY, "doppler-token") : undefined;
  let generationRoot = "/run/runtime-secrets";
  const eligible = [];
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (["--instance", "--credential", "--generation-root", "--eligible"].includes(option) && value === undefined) usage();
    if (option === "--instance") { instancePath = resolve(value); index += 1; }
    else if (option === "--credential") { credentialPath = resolve(value); index += 1; }
    else if (option === "--generation-root") { generationRoot = resolve(value); index += 1; }
    else if (option === "--eligible") { eligible.push(value); index += 1; }
    else usage();
  }
  if (!instancePath) usage();
  if (command === "render" && !credentialPath) throw new RuntimeSecretsError("authentication", "No systemd credential is configured", ExitCode.AUTH);
  if (command !== "prune" && eligible.length) usage();
  if (command === "prune" && eligible.length === 0) throw new RuntimeSecretsError("usage", "prune requires at least one --eligible generation", ExitCode.USAGE);
  return { command, instancePath, credentialPath, eligible, generationRoot };
}
function usage() {
  throw new RuntimeSecretsError("usage", "Usage: runtime-secrets <render|activate|discard|restore|prune|status> --instance <absolute-path> [--credential <path>] [--eligible <generation>]", ExitCode.USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)).catch((error) => {
    const safe = error instanceof RuntimeSecretsError ? error : new RuntimeSecretsError("internal", "Runtime secrets operation failed", ExitCode.FILESYSTEM);
    process.stderr.write(`${JSON.stringify({ ok: false, category: safe.category, message: safe.message })}\n`);
    process.exitCode = safe.exitCode;
  });
}

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ExitCode, fail, RuntimeSecretsError } from "./errors.mjs";
import { parseStrictJson } from "./json.mjs";

export async function retrieveDoppler(instance, { credentialPath, spawnImpl = spawn, sleep = defaultSleep, downloadImpl = runDownload } = {}) {
  if (!credentialPath) fail("authentication", "Doppler credential path is missing", ExitCode.AUTH);
  let token;
  try {
    token = await readFile(credentialPath, "utf8");
  } catch (error) {
    fail("authentication", "Doppler service token is unavailable", ExitCode.AUTH, { cause: error });
  }
  token = token.replace(/\r?\n$/u, "");
  if (!token || token.includes("\n") || token.includes("\r") || token.includes("\0")) {
    fail("authentication", "Doppler service token credential is invalid", ExitCode.AUTH);
  }
  let lastError;
  for (let attempt = 0; attempt <= instance.providerRetries; attempt += 1) {
    try {
      const text = await downloadImpl(instance, token, spawnImpl);
      return parseStrictJson(text, "Doppler payload", instance.maxPayloadBytes);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderProcessError) || !error.transient || attempt === instance.providerRetries) break;
      await sleep(250 * (2 ** attempt));
    }
  }
  if (lastError instanceof ProviderProcessError && lastError.authentication) {
    fail("authentication", "Doppler rejected the service token", ExitCode.AUTH, { cause: lastError });
  }
  if (lastError instanceof RuntimeSecretsError) throw lastError;
  fail("provider", "Doppler retrieval failed", ExitCode.PROVIDER, { cause: lastError });
}

async function runDownload(instance, token, spawnImpl) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(instance.dopplerExecutable, ["secrets", "download", "--no-file", "--no-fallback", "--format", "json"], {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/run/runtime-secrets-home", TMPDIR: process.env.TMPDIR ?? "/tmp", DOPPLER_TOKEN: token, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let stderrSize = 0;
    let finished = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ProviderProcessError("timeout", true, false));
    }, instance.providerTimeoutSeconds * 1000);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    child.on("error", () => finish(new ProviderProcessError("spawn", true, false)));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > instance.maxPayloadBytes) {
        child.kill("SIGKILL");
        finish(new RuntimeSecretsError("validation", "Doppler payload exceeds configured limit", ExitCode.VALIDATION));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const remaining = 8192 - stderrSize;
      if (remaining > 0) {
        const bounded = chunk.subarray(0, remaining);
        stderr.push(bounded);
        stderrSize += bounded.length;
      }
    });
    child.on("close", (code) => {
      if (code === 0) return finish(undefined, Buffer.concat(stdout).toString("utf8"));
      const summary = Buffer.concat(stderr).toString("utf8").toLowerCase();
      const { authentication, transient } = classifyProviderFailure(summary);
      finish(new ProviderProcessError(`exit-${code ?? "signal"}`, transient, authentication));
    });
  });
}

export class ProviderProcessError extends Error {
  constructor(message, transient, authentication) {
    super(message);
    this.transient = transient;
    this.authentication = authentication;
  }
}
export function classifyProviderFailure(summary) {
  const text = String(summary).toLowerCase();
  const authentication = /(?:401|403|unauthorized|forbidden|invalid token|invalid auth|revoked)/u.test(text);
  const transient = !authentication && /(?:429|rate limit|timeout|timed out|connection|network|502|503|504)/u.test(text);
  return { authentication, transient };
}
function defaultSleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

// Deployment health verification.
//
// Service-state contract for each required long-running service:
//   * every container of the service exists and is `running`;
//   * when the image/Compose defines a Docker health check, it is `healthy`;
//   * without a health check, the same container stays running for a
//     stability window (min(10s, timeout/2)) rather than being assumed healthy.
// `exited`, `dead` or `unhealthy` fail immediately. HTTP checks run from the
// host against registry-approved hosts and must return an expected status.
// Success requires every service and every HTTP check to pass in one round.
import { isLoopback } from "./compose-policy.mjs";
import { fail } from "./contract.mjs";

export function stabilityWindowMs(timeoutSeconds) {
  return Math.min(10_000, Math.floor((timeoutSeconds * 1000) / 2));
}

export function assertHealthCheckHosts(checks, allowedHosts) {
  for (const check of checks) {
    const host = new URL(check.url).hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (!allowedHosts.includes(host) && !(allowedHosts.includes("127.0.0.1") && isLoopback(host))) {
      fail("validation", `health check '${check.name}' targets a host that the host registry does not allow`);
    }
  }
}

export function evaluateServices(entries, services, tracker, nowMs, windowMs) {
  const results = [];
  let failedFast = null;
  for (const service of services) {
    const containers = (entries ?? []).filter((entry) => entry.service === service && !entry.oneOff);
    if (containers.length === 0) {
      results.push({ service, ok: false, state: "missing", health: "" });
      continue;
    }
    let ok = true;
    let summary = null;
    for (const container of containers) {
      summary = { service, state: container.state, health: container.health, exitCode: container.state === "running" ? null : container.exitCode };
      if (container.state === "exited" || container.state === "dead") { failedFast ??= `${service} is ${container.state}`; ok = false; continue; }
      if (container.health === "unhealthy") { failedFast ??= `${service} is unhealthy`; ok = false; continue; }
      if (container.state !== "running") { ok = false; continue; }
      if (container.health) { if (container.health !== "healthy") ok = false; continue; }
      const key = `${service}/${container.id}`;
      if (!tracker.has(key)) tracker.set(key, nowMs);
      if (nowMs - tracker.get(key) < windowMs) ok = false;
    }
    for (const key of [...tracker.keys()]) {
      if (key.startsWith(`${service}/`) && !containers.some((container) => key === `${service}/${container.id}` && container.state === "running")) tracker.delete(key);
    }
    results.push({ ...summary, ok });
  }
  return { ok: results.every((item) => item.ok), failedFast, services: results };
}

export async function runHttpCheck(check, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const response = await fetchImpl(check.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    try { await response.body?.cancel(); } catch { /* body is never read or logged */ }
    return { name: check.name, status: response.status, ok: check.expectedStatus.includes(response.status) };
  } catch {
    return { name: check.name, status: null, ok: false };
  }
}

export async function verifyHealth({ services, checks, timeoutSeconds, inspect, fetchImpl, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = 3000 }) {
  const started = now();
  const deadline = started + timeoutSeconds * 1000;
  const windowMs = stabilityWindowMs(timeoutSeconds);
  const tracker = new Map();
  let last = { services: [], checks: [] };
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const entries = await inspect();
    const serviceResult = evaluateServices(entries, services, tracker, now(), windowMs);
    const checkResults = serviceResult.failedFast ? [] : await Promise.all(checks.map((check) => runHttpCheck(check, { fetchImpl })));
    last = { services: serviceResult.services, checks: checkResults };
    if (serviceResult.failedFast) return { healthy: false, reason: serviceResult.failedFast, rounds, durationSeconds: Math.round((now() - started) / 1000), ...last };
    if (serviceResult.ok && checkResults.every((item) => item.ok)) return { healthy: true, reason: "all required checks passed", rounds, durationSeconds: Math.round((now() - started) / 1000), ...last };
    if (now() >= deadline) {
      const pendingService = serviceResult.services.find((item) => !item.ok);
      const pendingCheck = checkResults.find((item) => !item.ok);
      const reason = pendingService ? `${pendingService.service} did not become ready (${pendingService.state}${pendingService.health ? `/${pendingService.health}` : ""})` : `health check '${pendingCheck?.name}' returned ${pendingCheck?.status ?? "no response"}`;
      return { healthy: false, reason: `health timeout after ${timeoutSeconds}s: ${reason}`, rounds, durationSeconds: Math.round((now() - started) / 1000), ...last };
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

import { describe, expect, it } from "vitest";
import { DockerCompose, parseComposePs, parseRestartCounts } from "../scripts/vps-deploy/docker.mjs";
import { assertHealthCheckHosts, evaluateServices, verifyHealth } from "../scripts/vps-deploy/health.mjs";

type Entry = { id: string; service: string; state: string; health: string; exitCode: number | null; oneOff: boolean; restartCount?: number | null };
const entry = (service: string, overrides: Partial<Entry> = {}): Entry => ({ id: `${service}-1`, service, state: "running", health: "healthy", exitCode: null, oneOff: false, ...overrides });

describe("service-state health contract", () => {
  it("accepts running healthy containers and ignores one-off containers", () => {
    const result = evaluateServices([entry("api"), entry("api", { id: "migration", oneOff: true, state: "exited", exitCode: 1 })], ["api"], new Map(), 0, 10_000);
    expect(result).toMatchObject({ ok: true, failedFast: null });
  });

  it.each([
    ["unhealthy", entry("api", { health: "unhealthy" }), "api is unhealthy"],
    ["exited", entry("api", { state: "exited", exitCode: 1 }), "api is exited"],
    ["dead", entry("api", { state: "dead" }), "api is dead"],
  ])("fails fast when a container is %s", (_label, container, reason) => {
    expect(evaluateServices([container], ["api"], new Map(), 0, 10_000)).toMatchObject({ ok: false, failedFast: reason });
  });

  it("reports missing required containers without failing fast", () => {
    const result = evaluateServices([entry("api")], ["api", "worker"], new Map(), 0, 10_000);
    expect(result.ok).toBe(false);
    expect(result.failedFast).toBeNull();
    expect(result.services.find((item: { service: string }) => item.service === "worker")).toMatchObject({ ok: false, state: "missing" });
  });

  it("does not accept a starting health check or a restarting container", () => {
    expect(evaluateServices([entry("api", { health: "starting" })], ["api"], new Map(), 0, 10_000).ok).toBe(false);
    expect(evaluateServices([entry("api", { state: "restarting", health: "" })], ["api"], new Map(), 0, 10_000).ok).toBe(false);
  });

  it("requires a stability window for containers without a health check", () => {
    const tracker = new Map();
    const worker = entry("worker", { health: "" });
    expect(evaluateServices([worker], ["worker"], tracker, 0, 10_000).ok).toBe(false);
    expect(evaluateServices([worker], ["worker"], tracker, 9_999, 10_000).ok).toBe(false);
    expect(evaluateServices([worker], ["worker"], tracker, 10_000, 10_000).ok).toBe(true);
    // A replaced container restarts the window.
    expect(evaluateServices([{ ...worker, id: "worker-2" }], ["worker"], tracker, 11_000, 10_000).ok).toBe(false);
  });

  it("fails fast when a container is restarted by its restart policy during verification", () => {
    const restarts = new Map();
    const tracker = new Map();
    expect(evaluateServices([entry("api", { restartCount: 4 })], ["api"], tracker, 0, 10_000, restarts).ok).toBe(true);
    expect(evaluateServices([entry("api", { restartCount: 4 })], ["api"], tracker, 1, 10_000, restarts).ok).toBe(true);
    expect(evaluateServices([entry("api", { restartCount: 5 })], ["api"], tracker, 2, 10_000, restarts)).toMatchObject({ ok: false, failedFast: "api terminated and was restarted during health verification" });
  });

  it("only allows HTTP checks to registry-approved hosts", () => {
    expect(() => assertHealthCheckHosts([{ name: "api", url: "http://localhost:8080/health" }], ["127.0.0.1"])).not.toThrow();
    expect(() => assertHealthCheckHosts([{ name: "meta", url: "http://169.254.169.254/" }], ["127.0.0.1"])).toThrow(/does not allow/u);
  });
});

describe("bounded health verification", () => {
  function clock() {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => { now += ms; } };
  }

  it("retries HTTP readiness until it passes within the window", async () => {
    const time = clock();
    let calls = 0;
    const result = await verifyHealth({
      services: ["api"], checks: [{ name: "api", url: "http://127.0.0.1/health", expectedStatus: [200] }], timeoutSeconds: 30,
      inspect: async () => [entry("api")], fetchImpl: async () => new Response(null, { status: ++calls < 3 ? 503 : 200 }), intervalMs: 1000, ...time,
    });
    expect(result).toMatchObject({ healthy: true, rounds: 3 });
  });

  it("fails at the deadline naming the failing check and its status only", async () => {
    const time = clock();
    const result = await verifyHealth({
      services: ["api"], checks: [{ name: "readiness", url: "http://127.0.0.1/ready", expectedStatus: [200] }], timeoutSeconds: 10,
      inspect: async () => [entry("api")], fetchImpl: async () => new Response("connection-string=sentinel", { status: 500 }), intervalMs: 1000, ...time,
    });
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe("health timeout after 10s: health check 'readiness' returned 500");
    expect(JSON.stringify(result)).not.toContain("sentinel");
  });

  it("treats a network failure as no response and an unavailable inspector as missing services", async () => {
    const time = clock();
    const result = await verifyHealth({
      services: ["api"], checks: [{ name: "api", url: "http://127.0.0.1/health", expectedStatus: [200] }], timeoutSeconds: 10,
      inspect: async () => null, fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, intervalMs: 1000, ...time,
    });
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/api did not become ready \(missing\)/u);
    expect(result.checks).toEqual([{ name: "api", status: null, ok: false }]);
  });
});

describe("docker adapter migration evidence", () => {
  type Call = { command: string; args: string[] };
  function adapter(responses: (call: Call) => { code: number; timedOut?: boolean; stdout?: string; stderr?: string }) {
    const calls: Call[] = [];
    const docker = new DockerCompose({
      temporaryRoot: "/tmp",
      run: async (command: string, args: string[]) => {
        const call = { command, args };
        calls.push(call);
        return { timedOut: false, stdout: "", stderr: "", ...responses(call) };
      },
    });
    return { docker, calls };
  }
  const project = { name: "stack", directory: "/srv/stack/releases/x", files: ["/srv/stack/releases/x/compose-1.yml"] };
  const isInspect = (call: Call) => call.args[0] === "container" && call.args[1] === "inspect";

  it("reports success only from the stopped container's recorded exit code", async () => {
    const { docker } = adapter((call) => isInspect(call) ? { code: 0, stdout: JSON.stringify({ Running: false, ExitCode: 0 }) } : { code: 0 });
    expect(await docker.runOneShot(project, "migrator", "stack-migration-1", { timeoutMs: 1000 })).toEqual({ timedOut: false, created: true, exitCode: 0, running: false, commandCode: 0 });
  });

  it("never derives a zero exit code from the CLI when the container does not exist", async () => {
    const { docker } = adapter((call) => isInspect(call) ? { code: 1 } : { code: 0 });
    expect(await docker.runOneShot(project, "migrator", "stack-migration-1", { timeoutMs: 1000 })).toMatchObject({ created: false, exitCode: null, commandCode: 0 });
  });

  it("does not report an exit code for a container that is still running", async () => {
    const { docker } = adapter((call) => isInspect(call) ? { code: 0, stdout: JSON.stringify({ Running: true, ExitCode: 0, Health: { Status: "healthy" } }) } : { code: 0 });
    expect(await docker.runOneShot(project, "migrator", "stack-migration-1", { timeoutMs: 1000 })).toMatchObject({ created: true, running: true, exitCode: null });
  });

  it("kills the migrator after a timeout", async () => {
    const { docker, calls } = adapter((call) => {
      if (call.args.includes("run")) return { code: 137, timedOut: true };
      if (isInspect(call)) return { code: 0, stdout: JSON.stringify({ Running: false, ExitCode: 137 }) };
      return { code: 0 };
    });
    const outcome = await docker.runOneShot(project, "migrator", "stack-migration-1", { timeoutMs: 1000 });
    expect(outcome).toMatchObject({ timedOut: true, exitCode: 137, commandCode: null });
    expect(calls.some((call) => call.args[0] === "kill" && call.args[1] === "stack-migration-1")).toBe(true);
  });

  it("lists running one-off migrators and fails closed when Docker cannot answer", async () => {
    const ok = adapter(() => ({ code: 0, stdout: "abc123\n" }));
    expect(await ok.docker.oneShotContainers("stack", "migrator", { running: true })).toEqual(["abc123"]);
    expect(ok.calls[0]?.args).toContain("status=running");
    const broken = adapter(() => ({ code: 1 }));
    await expect(broken.docker.oneShotContainers("stack", "migrator", { running: true })).rejects.toThrow(/could not determine/u);
    expect(await broken.docker.oneShotContainers("stack", "migrator")).toEqual([]);
  });

  it("attaches Docker restart counts to compose ps entries", async () => {
    const full = "a".repeat(64);
    const { docker } = adapter((call) => {
      if (call.args.includes("ps")) return { code: 0, stdout: JSON.stringify({ ID: full.slice(0, 12), Service: "api", State: "running", Health: "healthy", Labels: "" }) };
      return { code: 0, stdout: `${full} 3\n` };
    });
    expect(await docker.ps("stack")).toEqual([{ id: full.slice(0, 12), service: "api", state: "running", health: "healthy", exitCode: null, oneOff: false, restartCount: 3 }]);
    expect(parseRestartCounts("junk\n")).toEqual(new Map());
    expect(parseComposePs("")).toEqual([]);
  });
});

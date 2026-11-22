import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowContractValidator } from "../../src/validation/workflow-contract-validator.js";
import { WorkflowSecurityValidator } from "../../src/validation/workflow-security-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const path = join(root, ".github", "workflows", "docker-publish.yml");
const source = readFileSync(path, "utf8");
const workflow = new YamlValidator().load(path);

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { outputs?: Record<string, string>; steps: Step[] } & Record<string, unknown>;
type Workflow = {
  on: { workflow_call: { inputs: Record<string, unknown>; secrets: Record<string, unknown>; outputs: Record<string, unknown> } };
  jobs: Record<string, Job>;
};
const parsed = workflow as unknown as Workflow;
const jobs = parsed.jobs;

/** Collects every string in a parsed YAML node (keys and values, any depth) with its location. */
function strings(node: unknown, location = "$"): Array<{ location: string; value: string }> {
  if (typeof node === "string") return [{ location, value: node }];
  if (Array.isArray(node)) return node.flatMap((item, index) => strings(item, `${location}[${index}]`));
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => [{ location: `${location}.${key}#key`, value: key }, ...strings(value, `${location}.${key}`)]);
  }
  return [];
}
const secretReference = /\bsecrets\s*(?:\.|\[)/u;
function secretReferences(node: unknown): string[] {
  return strings(node).filter(({ value }) => secretReference.test(value)).map(({ location }) => location);
}
function stepIndex(job: Job, predicate: (step: Step) => boolean, label: string): number {
  const index = job.steps.findIndex(predicate);
  expect(index, `${label} step must exist`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("docker publish reusable workflow", () => {
  it("matches the documented public contract and security policy", () => {
    const contract = readFileSync(join(root, "docs", "workflow-contracts.md"), "utf8");
    expect(() => new WorkflowContractValidator().validate(path, workflow, contract)).not.toThrow();
    expect(() => new WorkflowSecurityValidator().validate(path, workflow)).not.toThrow();
  });

  it("validates before login and aggregates artifacts outside the matrix", () => {
    expect(source.indexOf("Validate configuration and inputs")).toBeLessThan(source.indexOf("Log in to Docker Hub"));
    expect(source).toContain("matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}");
    expect(source).toContain("pattern: image-result-*");
    expect(source).not.toContain("secrets: inherit");
  });

  it("uses digest scans, BuildKit secret mounts, and immutable action pins", () => {
    expect(source).toContain("GITHUB_USERNAME=PACKAGE_USERNAME");
    expect(source).toContain("GITHUB_PAT=PACKAGE_TOKEN");
    expect(source).toContain("@${{ steps.build_public.outputs.digest || steps.build_private.outputs.digest }}");
    expect(source).toContain("severity: CRITICAL");
    expect(source).toContain("provenance: ${{ inputs.generate-provenance }}");
    expect(source).not.toContain("packages: write");
    expect(source).not.toContain(":latest");
  });
});

describe("docker publish secret boundaries", () => {
  it("detects secret references in every job field shape the check relies on", () => {
    // Guards the traversal itself so a refactor cannot silently make the boundary checks vacuous.
    const probes: Array<[string, unknown]> = [
      ["step env", { steps: [{ env: { A: "${{ secrets.x }}" } }] }],
      ["job env", { env: { A: "${{ secrets.x }}" }, steps: [] }],
      ["with", { steps: [{ with: { password: "${{ secrets.x }}" } }] }],
      ["step if", { steps: [{ if: "${{ secrets.x != '' }}" }] }],
      ["job if", { if: "secrets.x != ''", steps: [] }],
      ["presence expression", { steps: [{ env: { PRESENT: "${{ secrets.x != '' }}" } }] }],
      ["index syntax", { steps: [{ env: { A: "${{ secrets['x'] }}" } }] }],
      ["run script", { steps: [{ run: "echo ${{ secrets.x }}" }] }],
      ["nested strategy", { strategy: { matrix: { include: [{ value: "${{ secrets.x }}" }] } }, steps: [] }],
      ["job outputs", { outputs: { a: "${{ secrets.x }}" }, steps: [] }],
      ["reusable job secrets", { secrets: { a: "${{ secrets.x }}" } }],
    ];
    for (const [label, probe] of probes) expect(secretReferences(probe), label).not.toEqual([]);
    expect(secretReferences({ steps: [{ env: { A: "${{ inputs.secretsless }}" } }] })).toEqual([]);
  });

  it.each(["prepare", "aggregate"])("keeps the %s job, which exports public metadata, free of secret references", (name) => {
    const job = jobs[name];
    expect(job).toBeDefined();
    expect(job?.outputs).toBeDefined();
    expect(secretReferences(job)).toEqual([]);
  });

  it("keeps build_publish free of job outputs so its secrets cannot suppress public metadata", () => {
    expect(jobs.build_publish?.outputs).toBeUndefined();
  });

  it("validates package credentials in build_publish before login, tag inspection, and any push", () => {
    const job = jobs.build_publish as Job;
    const check = stepIndex(job, (step) => step.name === "Validate package credentials", "credential validation");
    const toolkit = stepIndex(job, (step) => step.name === "Check out matching toolkit implementation", "toolkit checkout");
    const login = stepIndex(job, (step) => String(step.uses ?? "").startsWith("docker/login-action@"), "Docker Hub login");
    const inspect = stepIndex(job, (step) => String(step.run ?? "").includes("imagetools inspect"), "immutable tag inspection");
    const pushes = job.steps.map((step, index) => ({ step, index })).filter(({ step }) => String(step.uses ?? "").startsWith("docker/build-push-action@"));
    expect(pushes).toHaveLength(2);
    expect(check).toBeGreaterThan(toolkit);
    expect(check).toBeLessThan(login);
    expect(check).toBeLessThan(inspect);
    for (const { index } of pushes) expect(check).toBeLessThan(index);

    const step = job.steps[check] as Step;
    expect(step.if).toBeUndefined();
    expect(step.run).toBe("node .devops-toolkit-source/scripts/docker-publish.mjs check-credentials");
    expect(step.env).toEqual({
      PACKAGE_AUTH_REQUIRED: "${{ matrix.packageAuth }}",
      PACKAGE_USERNAME: "${{ secrets.github-packages-username }}",
      PACKAGE_TOKEN: "${{ secrets.github-packages-token }}",
    });
  });

  it("preserves BuildKit secret mappings and per-component authentication conditions", () => {
    const job = jobs.build_publish as Job;
    const publicBuild = job.steps.find((step) => step.id === "build_public") as Step;
    const privateBuild = job.steps.find((step) => step.id === "build_private") as Step;
    expect(publicBuild.if).toBe("${{ !matrix.packageAuth }}");
    expect(secretReferences(publicBuild)).toEqual([]);
    expect(privateBuild.if).toBe("${{ matrix.packageAuth }}");
    expect(privateBuild.env).toEqual({
      PACKAGE_USERNAME: "${{ secrets.github-packages-username }}",
      PACKAGE_TOKEN: "${{ secrets.github-packages-token }}",
    });
    expect(privateBuild.with?.["secret-envs"]).toBe("GITHUB_USERNAME=PACKAGE_USERNAME\nGITHUB_PAT=PACKAGE_TOKEN\n");
    expect(privateBuild.with).not.toHaveProperty("build-secrets");
    expect(String(privateBuild.with?.["build-args"])).not.toMatch(/PACKAGE|GITHUB_PAT|secrets/u);
  });

  it("preserves the public workflow interface and internal job outputs", () => {
    const call = parsed.on.workflow_call;
    expect(Object.keys(call.inputs)).toEqual([
      "deployment-id", "image-config-path", "package-auth-components", "source-repository", "source-commit", "build-ref",
      "registry", "platforms", "enable-cache", "scan-images", "generate-sbom", "generate-provenance", "artifact-retention-days",
    ]);
    expect(Object.keys(call.secrets)).toEqual(["registry-username", "registry-token", "github-packages-username", "github-packages-token"]);
    expect(Object.keys(call.outputs)).toEqual(["deployment-id", "manifest-json", "manifest-artifact", "published-images"]);
    expect(jobs.prepare?.outputs).toEqual({
      "matrix": "${{ steps.prepare.outputs.matrix }}",
      "deployment-id": "${{ steps.prepare.outputs.deployment-id }}",
      "tag": "${{ steps.prepare.outputs.tag }}",
      "source-repository": "${{ steps.prepare.outputs.source-repository }}",
      "source-commit": "${{ steps.prepare.outputs.source-commit }}",
      "build-reference": "${{ steps.prepare.outputs.build-reference }}",
      "retention-days": "${{ steps.prepare.outputs.retention-days }}",
    });
    expect(Object.keys(jobs.aggregate?.outputs ?? {})).toEqual(["manifest-json", "manifest-artifact", "published-images"]);
  });
});

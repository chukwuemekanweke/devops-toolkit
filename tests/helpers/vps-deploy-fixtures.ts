export const digest = (char: string) => `sha256:${char.repeat(64)}`;
export const repository = "example/backend";
export const commit = "0123456789abcdef0123456789abcdef01234567";

export function manifestObject(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    deployment_id: commit,
    source_repository: repository,
    source_commit: commit,
    build_reference: `https://github.com/${repository}/actions/runs/1`,
    created_at: "2026-11-21T12:00:00.000Z",
    components: [
      { name: "webapi", image: "docker.io/example/backend-webapi", digest: digest("a") },
      { name: "migrator", image: "docker.io/example/backend-migrator", digest: digest("b") },
    ],
    ...overrides,
  };
}

export function workflow() {
  return {
    repository, ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`, sha: commit, runId: "42", runAttempt: "1",
    actor: "octocat", eventName: "push", toolkitRepository: "example/devops-toolkit", toolkitSha: commit, runUrl: `https://github.com/${repository}/actions/runs/42`,
  };
}

export function requestObject(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    environment: "production",
    deploymentId: commit,
    stackName: "example-backend-production",
    remoteDeploymentPath: "/srv/example-backend/production",
    composeFiles: [{ path: "deploy/compose.yml", content: "services: {}\n" }],
    componentServiceMap: { migrator: "database-migrator" },
    migrationService: "database-migrator",
    migrationTimeoutSeconds: 600,
    healthServices: [],
    healthChecks: [{ name: "api", url: "http://127.0.0.1:8080/health" }],
    healthTimeoutSeconds: 300,
    rollbackOnHealthFailure: true,
    workflow: workflow(),
    ...overrides,
  };
}


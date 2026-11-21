export const ExitCode = Object.freeze({
  OK: 0,
  USAGE: 2,
  CONFIG: 10,
  AUTH: 20,
  PROVIDER: 21,
  VALIDATION: 30,
  FILESYSTEM: 40,
  CONFLICT: 41,
});

export class RuntimeSecretsError extends Error {
  constructor(category, message, exitCode, options) {
    super(message, options);
    this.name = "RuntimeSecretsError";
    this.category = category;
    this.exitCode = exitCode;
  }
}

export function fail(category, message, exitCode, options) {
  throw new RuntimeSecretsError(category, message, exitCode, options);
}

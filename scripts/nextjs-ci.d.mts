export interface CommandResult { status: number; stdout: string }
export interface NextjsSummary {
  buildArtifact: string; buildResult: string; lintResult: string; testResult: string;
  typecheckResult: string; verificationPassed: boolean;
}
export function parseWorkspaceFilters(value?: string): string[];
export function buildScriptArguments(script: string, filters: string[]): string[];
export function validateInputs(environment: NodeJS.ProcessEnv, workspace: string): {
  artifactInputs: string[]; filters: string[]; lockfileRelative: string; nodeVersion: string;
  nodeVersionFile: string; pnpmVersion: string; retentionDays: number; workingDirectory: string;
  workingDirectoryRelative: string;
};
export function validatePackageScripts(workingDirectory: string, enabledScripts: string[]): void;
export function validateSelection(workingDirectory: string, filters: string[], runCommand?: (command: string, args: string[], cwd: string, capture: boolean) => CommandResult): unknown[];
export function copyBuildConfig(workingDirectory: string, mappingText: string): string[];
export function validateArtifactPaths(workingDirectory: string, pathsText: string): string[];
export function calculateSummary(values: {
  artifactName: string; artifactOutcome: string; buildOutcome: string; lintOutcome: string;
  runBuild: boolean; runLint: boolean; runTests: boolean; runTypecheck: boolean; testOutcome: string;
  typecheckOutcome: string; uploadArtifacts: boolean;
}): NextjsSummary;

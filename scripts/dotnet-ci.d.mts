export interface ValidatedInputs {
  configuration: string;
  diagnostics: string;
  dotnetVersion: string;
  retentionDays: number;
  solutionPath: string;
  solutionRelative: string;
  workingDirectory: string;
  workingDirectoryRelative: string;
}

export function validateInputs(environment: NodeJS.ProcessEnv, workspace: string): ValidatedInputs;
export function discoverProjects(root: string, patternsText: string): string[];
export function executeTestProjects(options: {
  category: string;
  collectCoverage: boolean;
  configuration: string;
  failOnEmpty: boolean;
  patterns: string;
  resultsRoot: string;
  runCommand?: (command: string, argumentsList: string[], cwd: string) => number;
  workingDirectory: string;
}): {
  failedProjects: string[];
  infrastructureFailure: boolean;
  projects: string[];
  resultsRoot: string;
};
export function stageBuildOutputs(
  workingDirectory: string,
  configuration: string,
  destination: string,
): number;
export function inspectCoverage(root: string, expected: boolean): string[];
export function calculateSummary(values: {
  buildResult: string;
  collectCoverage: boolean;
  coverageExpected: boolean;
  coverageArtifactName: string;
  coverageResult: string;
  coverageUploaded: boolean;
  integrationResult: string;
  runIntegrationTests: boolean;
  runUnitTests: boolean;
  testResultsArtifactName: string;
  testResultsUploaded: boolean;
  unitResult: string;
}): {
  buildResult: string;
  coverageArtifact: string;
  integrationTestResult: string;
  testResultsArtifact: string;
  unitTestResult: string;
  verificationPassed: boolean;
};

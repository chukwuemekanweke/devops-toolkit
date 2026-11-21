import { RepositoryValidator } from "./repository-validator.js";

try {
  const root = RepositoryValidator.findRepositoryRoot(process.argv[2] ?? process.cwd());
  const errors = new RepositoryValidator().validate(root);
  if (errors.length > 0) {
    console.error("Repository validation failed:");
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Repository validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

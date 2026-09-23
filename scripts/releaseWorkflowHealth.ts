import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectReleaseBridgeIssues, collectReleaseWorkflowIssues } from './releaseWorkflow.js';

// Reports the invariants of the release path that no other gate reads. `docs:check` resolves links inside
// workflow files and `license:check` reads their text, but nothing until now has asked whether the bridge
// still dispatches on the event Flight sends, or whether two publishing workflows could run at once.
//
// Every workflow read is counted in the summary, so a clean run is readable as measured rather than as a
// walk that reached nothing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const workflows = [
  { collect: collectReleaseBridgeIssues, file: '.github/workflows/release-bridge.yml' },
  { collect: collectReleaseWorkflowIssues, file: '.github/workflows/release.yml' },
] as const;

const errors: string[] = [];
for (const workflow of workflows) {
  let contents: string;
  try {
    contents = readFileSync(path.join(root, workflow.file), 'utf8');
  } catch {
    // A release workflow that is not there is a finding, not a stack: the bridge is the receiving half of a
    // contract another repository dispatches into.
    errors.push(`${workflow.file}: the workflow is missing`);
    continue;
  }
  errors.push(...workflow.collect(workflow.file, contents));
}

if (errors.length > 0) {
  process.stderr.write(`Release workflow health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(`Release workflow health passed for ${String(workflows.length)} workflows.\n`);

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectCiWorkflowIssues } from './ciWorkflow.js';
import { collectReleaseBridgeIssues, collectReleaseWorkflowIssues } from './releaseWorkflow.js';

// Reports the structural workflow invariants that no other gate reads. `docs:check` resolves links inside
// workflow files and `license:check` reads their text, but neither checks which target a CI lane executes,
// whether the receiver still triggers on the event Flight sends, or whether two publishing workflows could
// run at once.
//
// The receiver is the workflow that takes Flight's dispatch. It is being authored as
// `.github/workflows/flight-release.yml` and is checked as soon as it exists: until then the run says so in
// its summary rather than passing quietly, because a gate that reports nothing about a workflow that is not
// there cannot be read as having checked it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ciFile = '.github/workflows/ci.yml';
const receiverFile = '.github/workflows/flight-release.yml';

const workflows = [
  { collect: collectReleaseBridgeIssues, file: receiverFile, receiver: true },
  { collect: collectReleaseWorkflowIssues, file: '.github/workflows/release.yml', receiver: false },
] as const;

const errors: string[] = [];
let checked = 0;
let receivers = 0;
if (!existsSync(path.join(root, ciFile))) {
  errors.push(`${ciFile}: the workflow is missing`);
} else {
  checked += 1;
  errors.push(...collectCiWorkflowIssues(ciFile, readFileSync(path.join(root, ciFile), 'utf8')));
}
for (const workflow of workflows) {
  if (!existsSync(path.join(root, workflow.file))) {
    // A receiver that is not there yet is pending, and the summary says so. Every other listed workflow must
    // exist: it is in the registry because it is a release path this repository ships.
    if (workflow.receiver) continue;
    errors.push(`${workflow.file}: the workflow is missing`);
    continue;
  }
  const contents = readFileSync(path.join(root, workflow.file), 'utf8');
  checked += 1;
  if (workflow.receiver) receivers += 1;
  errors.push(...workflow.collect(workflow.file, contents));
}

if (errors.length > 0) {
  process.stderr.write(`Release workflow health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `Workflow health passed for ${String(checked)} workflow(s) and ${String(receivers)} release receiver(s).\n` +
    (receivers === 0 ? `${receiverFile} is not there, so nothing received a dispatch.\n` : ''),
);

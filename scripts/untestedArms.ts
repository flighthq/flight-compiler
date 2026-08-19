import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectUnreachedArms } from './coverageBranchReport.js';
import type { CoverageFileEntry } from './coverageBranchReport.js';

// Lists the branch and statement arms in one package that no test ever took: `npm run untested -- patch`.
//
// It is a list, not a score, and nothing here gates. A gated percentage rewards hollow tests that
// execute a line without asserting anything; a list of locations only rewards going and looking.
//
// Scoping coverage to the named package is the whole trick. An unscoped run reports every module the
// test loaded, including dependencies pulled in with none of their own tests, which sends a reader to
// fix a package they are not working in.
//
// Nothing it produces is committed: the coverage JSON lands in a temporary directory removed on the
// way out. A derived view that costs seconds to rebuild should be rebuilt, not merged.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const selector = process.argv[2];

if (selector === undefined) {
  process.stderr.write('Name a package: npm run untested -- <package>\n');
  process.exit(1);
}

const packageName = resolvePackageName(selector);
if (packageName === undefined) {
  process.stderr.write(`No package directory matches '${selector}' under packages/.\n`);
  process.exit(1);
}

const sourceGlob = `packages/${packageName}/src/**/*.ts`;
const reportDirectory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-untested-'));
const vitest = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');

try {
  const run = spawnSync(
    vitest,
    [
      'run',
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${reportDirectory}`,
      `--coverage.include=${sourceGlob}`,
      // The repository ratchets measure the whole tree; a single-package run is a different
      // denominator, so enforcing them here would report a threshold failure that means nothing.
      '--coverage.thresholds.branches=0',
      '--coverage.thresholds.functions=0',
      '--coverage.thresholds.lines=0',
      '--coverage.thresholds.statements=0',
      `packages/${packageName}`,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (run.status !== 0) {
    process.stderr.write(`Coverage run for ${packageName} failed, so nothing was measured.\n`);
    process.exit(1);
  }

  const reportFile = path.join(reportDirectory, 'coverage-final.json');
  if (!existsSync(reportFile)) {
    process.stderr.write(`Coverage run for ${packageName} wrote no report, so nothing was measured.\n`);
    process.exit(1);
  }

  const coverage = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, CoverageFileEntry>;
  const measuredFiles = Object.keys(coverage).length;
  if (measuredFiles === 0) {
    process.stderr.write(`Coverage for ${packageName} covered no files, so this run measured nothing.\n`);
    process.exit(1);
  }

  const arms = collectUnreachedArms(coverage);
  for (const arm of arms) {
    process.stdout.write(`${path.relative(root, arm.path).replaceAll('\\', '/')}:${String(arm.line)} ${arm.kind}\n`);
  }
  process.stdout.write(
    `\n${String(arms.length)} unreached arm(s) across ${String(measuredFiles)} measured file(s) in ${packageName}.\n`,
  );
} finally {
  rmSync(reportDirectory, { force: true, recursive: true });
}

function resolvePackageName(selected: string): string | undefined {
  const names = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return names.find((name) => name === selected) ?? names.find((name) => name === `compiler-${selected}`);
}

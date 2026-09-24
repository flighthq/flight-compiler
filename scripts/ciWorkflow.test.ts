import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectCiWorkflowIssues } from './ciWorkflow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ciFile = '.github/workflows/ci.yml';

function readCi(): string {
  return readFileSync(path.join(root, ciFile), 'utf8');
}

function mutated(replace: string | RegExp, replacement: string): string {
  const contents = readCi();
  const change = contents.replace(replace, replacement);
  expect(change).not.toBe(contents);
  return change;
}

describe('collectCiWorkflowIssues', () => {
  it('accepts the CI workflow this repository ships', () => {
    expect(collectCiWorkflowIssues(ciFile, readCi())).toEqual([]);
  });

  it('reports a workflow it cannot read', () => {
    expect(collectCiWorkflowIssues(ciFile, 'jobs: [unclosed')).toEqual([
      `${ciFile}: the workflow is not readable YAML`,
    ]);
  });

  it('reports every C++ job that lets installed non-C++ targets enter its oracle lane', () => {
    const contents = mutated(/npm run oracle:check -- --target cpp/gu, 'npm run oracle:check');

    expect(collectCiWorkflowIssues(ciFile, contents)).toEqual([
      `${ciFile}: C++ job cpp-conformance selects all installed oracle targets, expected exactly cpp`,
      `${ciFile}: C++ job cpp-generated-corpus selects all installed oracle targets, expected exactly cpp`,
    ]);
  });

  it('reports an explicitly crossed target lane', () => {
    const contents = mutated('npm run oracle:check -- --target cpp', 'npm run oracle:check -- --target rust');

    expect(collectCiWorkflowIssues(ciFile, contents)).toContain(
      `${ciFile}: C++ job cpp-conformance selects rust, expected exactly cpp`,
    );
  });

  it('reports a C++ job whose oracle step was removed', () => {
    const contents = mutated('npm run oracle:check -- --target cpp', 'npm run typecheck');

    expect(collectCiWorkflowIssues(ciFile, contents)).toContain(
      `${ciFile}: C++ job cpp-conformance has 0 oracle steps, expected 1`,
    );
  });

  it('reports a missing C++ oracle job', () => {
    const contents = mutated('  cpp-conformance:', '  renamed-cpp-conformance:');

    expect(collectCiWorkflowIssues(ciFile, contents)).toContain(
      `${ciFile}: required C++ oracle job cpp-conformance is missing`,
    );
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CompilerInventoryFailureCode } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { readGitCommit } from './gitCheckoutRevision.js';

describe('readGitCommit', () => {
  it('returns the exact checkout commit and rejects a directory without repository identity', () => {
    const checkout = createGitCheckout();
    const plainDirectory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-no-git-'));
    try {
      const expected = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      expect(readGitCommit(checkout)).toBe(expected);
      expectInventoryFailure(() => readGitCommit(plainDirectory), 'invalid-git-commit');
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(plainDirectory, { force: true, recursive: true });
    }
  });
});

function createGitCheckout(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-git-checkout-'));
  writeFileSync(path.join(directory, 'fixture.txt'), 'fixture');
  git(directory, 'init');
  git(directory, 'config', 'user.email', 'compiler@example.invalid');
  git(directory, 'config', 'user.name', 'Compiler Fixture');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'fixture');
  return directory;
}

function expectInventoryFailure(run: () => unknown, code: CompilerInventoryFailureCode): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(isCompilerInventoryFailure(failure)).toBe(true);
  expect(failure).toMatchObject({ code, kind: 'compiler-inventory' });
}

function git(directory: string, ...arguments_: string[]): void {
  execFileSync('git', ['-C', directory, ...arguments_], { stdio: 'ignore' });
}

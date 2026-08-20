import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

export function readGitCommit(directory: string): string {
  try {
    const commit = execFileSync('git', ['-C', path.resolve(directory), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
      throw createCompilerInventoryFailure(
        'invalid-git-commit',
        path.resolve(directory),
        `Git returned an invalid commit: ${commit}`,
      );
    }
    return commit;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw createCompilerInventoryFailure(
      'invalid-git-commit',
      path.resolve(directory),
      `Upstream directory is not an initialized Git checkout${detail}`,
      error,
    );
  }
}

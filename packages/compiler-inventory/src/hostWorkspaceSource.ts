import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import type { WorkspaceSource, WorkspaceSourceEntry } from '../../compiler-types/src/index.js';

// The one place inventory touches the host filesystem. Everything else takes the capability, so the
// import of `node:fs` above is the package's complete host surface for reading a workspace.

export function createHostWorkspaceSource(): WorkspaceSource {
  return {
    isDirectory: (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isDirectory(),
    isFile: (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile(),
    listDirectory: (directory: string): readonly WorkspaceSourceEntry[] =>
      readdirSync(directory, { withFileTypes: true }).map((entry) => ({
        isDirectory: entry.isDirectory(),
        name: entry.name,
      })),
    readTextFile: (file: string): string => readFileSync(file, 'utf8'),
  };
}

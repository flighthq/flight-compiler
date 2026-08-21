import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import type { WorkspaceSource, WorkspaceSourceEntry } from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

// The one place inventory touches a real filesystem. Everything else takes the capability, so the
// import of `node:fs` above is the package's complete filesystem surface for reading a workspace.

export function createFileSystemWorkspaceSource(): WorkspaceSource {
  return {
    isDirectory: (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isDirectory(),
    isFile: (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile(),
    listDirectory: (directory: string): readonly WorkspaceSourceEntry[] =>
      readdirSync(directory, { withFileTypes: true }).map((entry) => {
        // On POSIX a backslash inside one entry is data; canonicalizing it later would make that
        // entry collide with a real nested path.
        if (entry.name.includes('\\')) {
          throw createCompilerInventoryFailure(
            'invalid-source-path',
            entry.name,
            `Workspace source entry name is not portable: ${JSON.stringify(entry.name)}`,
          );
        }
        return { isDirectory: entry.isDirectory(), name: entry.name };
      }),
    readTextFile: (file: string): string => readFileSync(file, 'utf8'),
  };
}

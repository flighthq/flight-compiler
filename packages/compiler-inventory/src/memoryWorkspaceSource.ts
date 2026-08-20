import path from 'node:path';

import type { WorkspaceSource, WorkspaceSourceEntry } from '../../compiler-types/src/index.js';

// A workspace held entirely in memory, keyed by absolute POSIX-style path.
//
// It exists so analysis can be exercised without a temporary directory — the inventory tests that
// built real trees were the slowest in the repository — and because a caller compiling from a
// virtual workspace (an editor, a bundler, a fixture generator) needs the same capability. Directory
// membership is derived from the file keys rather than stored, so a workspace cannot describe a
// directory that contains nothing.

export function createMemoryWorkspaceSource(files: Readonly<Record<string, string>>): WorkspaceSource {
  const normalized = new Map(Object.entries(files).map(([file, contents]) => [normalize(file), contents]));
  const directories = new Set<string>();
  for (const file of normalized.keys()) {
    for (let parent = path.posix.dirname(file); parent !== '/' && parent !== '.'; parent = path.posix.dirname(parent)) {
      directories.add(parent);
    }
    directories.add('/');
  }

  return {
    isDirectory: (candidate: string): boolean => directories.has(normalize(candidate)),
    isFile: (candidate: string): boolean => normalized.has(normalize(candidate)),
    listDirectory: (directory: string): readonly WorkspaceSourceEntry[] => {
      const prefix = normalize(directory);
      if (!directories.has(prefix)) {
        throw new Error(`Memory workspace has no directory: ${prefix}`);
      }
      const entries = new Map<string, WorkspaceSourceEntry>();
      for (const file of normalized.keys()) {
        const scope = prefix === '/' ? '/' : `${prefix}/`;
        if (!file.startsWith(scope)) continue;
        const remainder = file.slice(scope.length);
        const separator = remainder.indexOf('/');
        const name = separator === -1 ? remainder : remainder.slice(0, separator);
        if (name.length > 0) entries.set(name, { isDirectory: separator !== -1, name });
      }
      // Names are Map keys, so two entries can never compare equal and the comparator needs no
      // equality arm.
      return [...entries.values()].sort((left, right) => (left.name < right.name ? -1 : 1));
    },
    readTextFile: (file: string): string => {
      const contents = normalized.get(normalize(file));
      if (contents === undefined) throw new Error(`Memory workspace has no file: ${normalize(file)}`);
      return contents;
    },
  };
}

function normalize(candidate: string): string {
  const posix = candidate.replaceAll('\\', '/');
  const resolved = path.posix.normalize(posix.startsWith('/') ? posix : `/${posix}`);
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

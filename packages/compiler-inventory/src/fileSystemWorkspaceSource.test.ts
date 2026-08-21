import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { createFileSystemWorkspaceSource } from './fileSystemWorkspaceSource.js';

// The only inventory test that still needs a real directory, because a filesystem source is exactly the
// thing an in-memory fixture cannot stand in for.
describe('createFileSystemWorkspaceSource', () => {
  it('reads, lists and classifies real filesystem entries', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-filesystem-workspace-'));
    try {
      mkdirSync(path.join(directory, 'packages'), { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), '{ "name": "flight" }');
      const source = createFileSystemWorkspaceSource();

      expect(source.readTextFile(path.join(directory, 'package.json'))).toBe('{ "name": "flight" }');
      expect(source.isFile(path.join(directory, 'package.json'))).toBe(true);
      expect(source.isDirectory(path.join(directory, 'packages'))).toBe(true);
      expect(source.isFile(path.join(directory, 'packages'))).toBe(false);
      expect(source.isDirectory(path.join(directory, 'absent'))).toBe(false);
      expect(source.isFile(path.join(directory, 'absent'))).toBe(false);
      expect(
        [...source.listDirectory(directory)].sort((left, right) => compareTextCodeUnits(left.name, right.name)),
      ).toEqual([
        { isDirectory: false, name: 'package.json' },
        { isDirectory: true, name: 'packages' },
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('refuses a legal POSIX backslash entry before it can collide with a nested source path', () => {
    if (path.sep !== '/') {
      expect(path.sep).toBe('\\');
      return;
    }

    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-filesystem-workspace-backslash-'));
    try {
      mkdirSync(path.join(directory, 'weird'), { recursive: true });
      writeFileSync(path.join(directory, 'weird', 'name.ts'), 'export const nested = true;\n');
      writeFileSync(path.join(directory, 'weird\\name.ts'), 'export const flat = true;\n');

      let failure: unknown;
      try {
        createFileSystemWorkspaceSource().listDirectory(directory);
      } catch (error) {
        failure = error;
      }

      expect(isCompilerInventoryFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: 'invalid-source-path',
        kind: 'compiler-inventory',
        subject: 'weird\\name.ts',
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

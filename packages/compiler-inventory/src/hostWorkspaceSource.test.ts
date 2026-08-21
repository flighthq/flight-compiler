import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareTextCodeUnits } from '../../compiler-ordering/src/index.js';
import { createHostWorkspaceSource } from './hostWorkspaceSource.js';

// The only inventory test that still needs a real directory, because a host source is exactly the
// thing an in-memory fixture cannot stand in for.
describe('createHostWorkspaceSource', () => {
  it('reads, lists and classifies real filesystem entries', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-host-workspace-'));
    try {
      mkdirSync(path.join(directory, 'packages'), { recursive: true });
      writeFileSync(path.join(directory, 'package.json'), '{ "name": "flight" }');
      const source = createHostWorkspaceSource();

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
});

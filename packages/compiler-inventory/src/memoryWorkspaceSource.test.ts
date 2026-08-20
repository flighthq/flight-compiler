import { createMemoryWorkspaceSource } from './memoryWorkspaceSource.js';

const workspace = {
  '/flight/package.json': '{ "name": "flight" }',
  '/flight/packages/math/package.json': '{ "name": "@flighthq/math" }',
  '/flight/packages/math/src/clamp.ts': 'export const clamp = 1;\n',
};

describe('createMemoryWorkspaceSource', () => {
  it('reads a file by absolute path', () => {
    expect(createMemoryWorkspaceSource(workspace).readTextFile('/flight/package.json')).toBe('{ "name": "flight" }');
  });

  it('normalizes separators, relative prefixes and traversal', () => {
    const source = createMemoryWorkspaceSource(workspace);

    expect(source.readTextFile('flight/package.json')).toBe('{ "name": "flight" }');
    expect(source.readTextFile('\\flight\\package.json')).toBe('{ "name": "flight" }');
    expect(source.readTextFile('/flight/packages/../package.json')).toBe('{ "name": "flight" }');
  });

  it('fails loudly for a file the workspace does not hold', () => {
    expect(() => createMemoryWorkspaceSource(workspace).readTextFile('/flight/missing.json')).toThrow(
      'Memory workspace has no file: /flight/missing.json',
    );
  });

  it('derives directory membership from the file keys', () => {
    const source = createMemoryWorkspaceSource(workspace);

    expect(source.isDirectory('/flight')).toBe(true);
    expect(source.isDirectory('/flight/packages/math/src')).toBe(true);
    expect(source.isDirectory('/flight/packages/math/src/clamp.ts')).toBe(false);
    expect(source.isDirectory('/flight/absent')).toBe(false);
  });

  it('separates files from directories', () => {
    const source = createMemoryWorkspaceSource(workspace);

    expect(source.isFile('/flight/package.json')).toBe(true);
    expect(source.isFile('/flight/packages')).toBe(false);
  });

  it('lists one level, marking directories, sorted and deduplicated', () => {
    expect(createMemoryWorkspaceSource(workspace).listDirectory('/flight')).toEqual([
      { isDirectory: false, name: 'package.json' },
      { isDirectory: true, name: 'packages' },
    ]);
  });

  it('lists a nested directory without its descendants', () => {
    expect(createMemoryWorkspaceSource(workspace).listDirectory('/flight/packages/math')).toEqual([
      { isDirectory: false, name: 'package.json' },
      { isDirectory: true, name: 'src' },
    ]);
  });

  it('fails loudly for a directory the workspace does not hold', () => {
    expect(() => createMemoryWorkspaceSource(workspace).listDirectory('/flight/absent')).toThrow(
      'Memory workspace has no directory: /flight/absent',
    );
  });

  it('lists the root directory', () => {
    const source = createMemoryWorkspaceSource({ '/flight/package.json': '{}', '/README.md': '# root\n' });

    expect(source.listDirectory('/')).toEqual([
      { isDirectory: false, name: 'README.md' },
      { isDirectory: true, name: 'flight' },
    ]);
  });

  it('ignores a trailing separator on a directory path', () => {
    const source = createMemoryWorkspaceSource(workspace);

    expect(source.isDirectory('/flight/packages/')).toBe(true);
    expect(source.listDirectory('/flight/packages/')).toEqual([{ isDirectory: true, name: 'math' }]);
  });

  it('holds an empty workspace without inventing entries', () => {
    const empty = createMemoryWorkspaceSource({});

    expect(empty.isDirectory('/')).toBe(false);
    expect(empty.isFile('/anything')).toBe(false);
  });
});

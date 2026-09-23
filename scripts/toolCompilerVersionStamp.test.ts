import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkToolCompilerVersionStamp,
  stampToolCompilerVersion,
  type ToolCompilerVersionStampInput,
} from './toolCompilerVersionStamp.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('tool compiler version stamp', () => {
  it('stamps stable and prerelease versions while preserving the manifest bytes around the field', () => {
    const original = '{\n  "name": "@flighthq/tool-compiler",\n  "version": "0.0.0",\n  "private": false\n}\n';
    const workspaceDirectory = createWorkspace(original);

    expect(stampToolCompilerVersion({ version: '0.4.0', workspaceDirectory })).toMatchObject({
      changed: true,
      previousVersion: '0.0.0',
      version: '0.4.0',
    });
    expect(readManifest(workspaceDirectory)).toBe(original.replace('"0.0.0"', '"0.4.0"'));

    expect(stampToolCompilerVersion({ version: '0.4.0-next.1811.dde7eb1', workspaceDirectory })).toMatchObject({
      changed: true,
      previousVersion: '0.4.0',
      version: '0.4.0-next.1811.dde7eb1',
    });
    expect(readManifest(workspaceDirectory)).toBe(original.replace('"0.0.0"', '"0.4.0-next.1811.dde7eb1"'));
  });

  it.each([
    '',
    ' ',
    '--next',
    '-1.0.0',
    '+build',
    '0.4.0+build',
    'v0.4.0',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2',
    '1.2.3-',
    '1.2.3-next..1',
    '1.2.3-next_1',
    '1.2.3\n"injected": true',
    '1.2.3; touch owned',
    '1.2.3$(touch owned)',
    '1.2.3`touch owned`',
  ])('rejects malformed version %j without touching the manifest', (version) => {
    const original = '{"name":"@flighthq/tool-compiler","version":"0.0.0"}\n';
    const workspaceDirectory = createWorkspace(original);

    expect(() => stampToolCompilerVersion({ version, workspaceDirectory })).toThrow(/strict SemVer/u);
    expect(readManifest(workspaceDirectory)).toBe(original);
  });

  it('reports an idempotent stamp without rewriting the manifest', () => {
    const original = '{\n\t"version": "0.4.0-next.1811.dde7eb1"\n}\n';
    const workspaceDirectory = createWorkspace(original);

    const result = stampToolCompilerVersion({
      version: '0.4.0-next.1811.dde7eb1',
      workspaceDirectory,
    });

    expect(result).toMatchObject({
      changed: false,
      previousVersion: '0.4.0-next.1811.dde7eb1',
      version: '0.4.0-next.1811.dde7eb1',
    });
    expect(readManifest(workspaceDirectory)).toBe(original);
  });

  it('changes only the top-level version token', () => {
    const original = [
      '{',
      '    "description": "built for version 0.0.0",',
      '    "metadata": { "version": "0.0.0" },',
      '    "version": "0.0.0",',
      '    "name": "@flighthq/tool-compiler"',
      '}',
      '',
    ].join('\n');
    const workspaceDirectory = createWorkspace(original);

    stampToolCompilerVersion({ version: '2.3.4-rc.1', workspaceDirectory });

    expect(readManifest(workspaceDirectory)).toBe(
      original.replace('    "version": "0.0.0",', '    "version": "2.3.4-rc.1",'),
    );
  });

  it.each([
    ['invalid JSON', '{"version":"0.0.0"'],
    ['a non-object root', '[{"version":"0.0.0"}]\n'],
    ['a missing version', '{"name":"@flighthq/tool-compiler"}\n'],
    ['a non-string version', '{"version":0}\n'],
    ['duplicate versions', '{"version":"0.0.0","version":"0.0.1"}\n'],
    ['an invalid existing version', '{"version":"latest"}\n'],
  ])('leaves a manifest with %s untouched', (_description, original) => {
    const workspaceDirectory = createWorkspace(original);

    expect(() => stampToolCompilerVersion({ version: '0.4.0', workspaceDirectory })).toThrow();
    expect(readManifest(workspaceDirectory)).toBe(original);
  });

  it('does not create a missing manifest', () => {
    const workspaceDirectory = createWorkspace();
    const manifestPath = getManifestPath(workspaceDirectory);

    expect(() => stampToolCompilerVersion({ version: '0.4.0', workspaceDirectory })).toThrow();
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('checks a valid stamp without writing and does not mutate its input', () => {
    const original = '{"version":"0.0.0"}\n';
    const workspaceDirectory = createWorkspace(original);
    const input: ToolCompilerVersionStampInput = { version: '0.4.0', workspaceDirectory };
    const snapshot = structuredClone(input);

    const result = checkToolCompilerVersionStamp(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({ changed: true, previousVersion: '0.0.0', version: '0.4.0' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(readManifest(workspaceDirectory)).toBe(original);
  });

  it('requires an absolute workspace path before reading a manifest', () => {
    expect(() => stampToolCompilerVersion({ version: '0.4.0', workspaceDirectory: 'relative-workspace' })).toThrow(
      /absolute workspace directory/u,
    );
  });

  it('restores the exact original manifest after a release stamp is reverted', () => {
    const original = '{\r\n  "name": "@flighthq/tool-compiler",\r\n  "version": "0.0.0",\r\n  "note": "0.0.0"\r\n}\r\n';
    const workspaceDirectory = createWorkspace(original);

    stampToolCompilerVersion({ version: '0.4.0-next.1811.dde7eb1', workspaceDirectory });
    stampToolCompilerVersion({ version: '0.0.0', workspaceDirectory });

    expect(readManifest(workspaceDirectory)).toBe(original);
  });
});

function createWorkspace(contents?: string): string {
  const workspaceDirectory = mkdtempSync(path.join(tmpdir(), 'flight-tool-compiler-version-'));
  temporaryDirectories.push(workspaceDirectory);
  if (contents !== undefined) {
    const manifestPath = getManifestPath(workspaceDirectory);
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, contents, 'utf8');
  }
  return workspaceDirectory;
}

function getManifestPath(workspaceDirectory: string): string {
  return path.join(workspaceDirectory, 'packages', 'tool-compiler', 'package.json');
}

function readManifest(workspaceDirectory: string): string {
  return readFileSync(getManifestPath(workspaceDirectory), 'utf8');
}

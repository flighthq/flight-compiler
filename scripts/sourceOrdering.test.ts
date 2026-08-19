import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectSourceOrderIssues, getImportGroup } from './sourceOrdering.js';

function parse(contents: string): ts.SourceFile {
  return ts.createSourceFile('/probe.ts', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function rules(contents: string, alphabetizeExports = true): string[] {
  return collectSourceOrderIssues(parse(contents), alphabetizeExports).map((issue) => issue.rule);
}

describe('getImportGroup', () => {
  it('separates builtins, external packages, and relative specifiers', () => {
    expect(getImportGroup('node:path')).toBe('builtin');
    expect(getImportGroup('typescript')).toBe('external');
    expect(getImportGroup('@flighthq/compiler-types')).toBe('external');
    expect(getImportGroup('./sibling.js')).toBe('relative');
    expect(getImportGroup('../../other/src/index.js')).toBe('relative');
  });
});

describe('collectSourceOrderIssues', () => {
  it('accepts imports in group order and alphabetized within each group', () => {
    const contents = [
      "import { spawnSync } from 'node:child_process';",
      "import path from 'node:path';",
      "import ts from 'typescript';",
      "import { helper } from '../../other/src/index.js';",
      "import { local } from './local.js';",
    ].join('\n');

    expect(collectSourceOrderIssues(parse(contents), true)).toEqual([]);
  });

  it('reports a builtin import that follows a relative one', () => {
    const contents = ["import { local } from './local.js';", "import path from 'node:path';"].join('\n');

    expect(rules(contents)).toEqual(['import-group-order']);
  });

  it('reports an external import that follows a relative one', () => {
    const contents = ["import { local } from './local.js';", "import ts from 'typescript';"].join('\n');

    expect(rules(contents)).toEqual(['import-group-order']);
  });

  it('reports an unsorted specifier inside one group', () => {
    const contents = ["import path from 'node:path';", "import { spawnSync } from 'node:child_process';"].join('\n');

    expect(rules(contents)).toEqual(['import-specifier-order']);
  });

  it('accepts two imports from the same specifier', () => {
    const contents = ["import { value } from './local.js';", "import type { Shape } from './local.js';"].join('\n');

    expect(collectSourceOrderIssues(parse(contents), true)).toEqual([]);
  });

  it('reports exported functions that are not alphabetized', () => {
    const contents = ['export function beta(): void {}', 'export function alpha(): void {}'].join('\n');

    expect(rules(contents)).toEqual(['export-alphabetization']);
  });

  it('ignores declaration order of functions that are not exported', () => {
    const contents = ['export function alpha(): void {}', 'function zulu(): void {}', 'function beta(): void {}'].join(
      '\n',
    );

    expect(collectSourceOrderIssues(parse(contents), true)).toEqual([]);
  });

  it('leaves exported function order alone when alphabetization is not requested', () => {
    const contents = ['export function beta(): void {}', 'export function alpha(): void {}'].join('\n');

    expect(collectSourceOrderIssues(parse(contents), false)).toEqual([]);
  });

  it('still checks imports when alphabetization is not requested', () => {
    const contents = ["import path from 'node:path';", "import { spawnSync } from 'node:child_process';"].join('\n');

    expect(rules(contents, false)).toEqual(['import-specifier-order']);
  });

  it('reports the one-based line and a readable detail', () => {
    const contents = ['export function beta(): void {}', '', 'export function alpha(): void {}'].join('\n');

    expect(collectSourceOrderIssues(parse(contents), true)).toEqual([
      { detail: 'exported function alpha precedes beta alphabetically', line: 3, rule: 'export-alphabetization' },
    ]);
  });

  it('returns nothing for a file with no imports or exported functions', () => {
    expect(collectSourceOrderIssues(parse('const value = 1;\n'), true)).toEqual([]);
  });
});

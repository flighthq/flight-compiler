import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { rewriteImportBlock } from './importBlockWriter.js';

function rewrite(contents: string): ReturnType<typeof rewriteImportBlock> {
  return rewriteImportBlock(
    ts.createSourceFile('/probe.ts', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    contents,
  );
}

describe('rewriteImportBlock', () => {
  it('orders a reversed block into builtin, external, then relative groups', () => {
    const result = rewrite(
      [
        "import { local } from './local.js';",
        "import ts from 'typescript';",
        "import path from 'node:path';",
        '',
        'export const value = 1;',
      ].join('\n'),
    );

    expect(result).toEqual({
      kind: 'ordered',
      text: [
        "import path from 'node:path';",
        '',
        "import ts from 'typescript';",
        '',
        "import { local } from './local.js';",
        '',
        'export const value = 1;',
      ].join('\n'),
    });
  });

  it('alphabetizes within a group without inserting a blank line', () => {
    const result = rewrite(
      ["import path from 'node:path';", "import { spawnSync } from 'node:child_process';"].join('\n'),
    );

    expect(result).toEqual({
      kind: 'ordered',
      text: ["import { spawnSync } from 'node:child_process';", "import path from 'node:path';"].join('\n'),
    });
  });

  it('reports an already ordered block as unchanged', () => {
    expect(rewrite(["import path from 'node:path';", '', "import ts from 'typescript';"].join('\n')).kind).toBe(
      'unchanged',
    );
  });

  it('treats a single import as unchanged', () => {
    expect(rewrite("import path from 'node:path';\n").kind).toBe('unchanged');
  });

  it('treats a file with no imports as unchanged', () => {
    expect(rewrite('export const value = 1;\n').kind).toBe('unchanged');
  });

  // Re-attaching a comment to the right import is the part a mechanical rewrite gets wrong, so the
  // writer declines instead of guessing.
  it('refuses a block containing a line comment', () => {
    const result = rewrite(
      ["import { local } from './local.js';", '// why this one is here', "import path from 'node:path';"].join('\n'),
    );

    expect(result).toEqual({ kind: 'refused', reason: 'a comment inside the import block' });
  });

  it('refuses a block containing a block comment', () => {
    const result = rewrite(
      ["import { local } from './local.js';", '/* explanation */', "import path from 'node:path';"].join('\n'),
    );

    expect(result.kind).toBe('refused');
  });

  it('leaves everything after the import block untouched', () => {
    const result = rewrite(
      [
        "import { local } from './local.js';",
        "import path from 'node:path';",
        '',
        '// a comment about the code',
        'export const value = 1;',
      ].join('\n'),
    );

    expect(result.kind).toBe('ordered');
    expect(
      result.kind === 'ordered' && result.text.endsWith('// a comment about the code\nexport const value = 1;'),
    ).toBe(true);
  });

  it('keeps every imported specifier', () => {
    const contents = [
      "import { local } from './local.js';",
      "import ts from 'typescript';",
      "import path from 'node:path';",
    ].join('\n');
    const result = rewrite(contents);

    expect(result.kind).toBe('ordered');
    for (const specifier of ['./local.js', 'typescript', 'node:path']) {
      expect(result.kind === 'ordered' && result.text.includes(specifier)).toBe(true);
    }
  });
});

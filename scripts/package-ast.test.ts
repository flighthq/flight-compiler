import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  collectLocalExportNames,
  collectModuleSpecifiers,
  containsTransientWorkComment,
  isExportedContractDeclaration,
} from './package-ast.js';

describe('package boundary AST analysis', () => {
  it('distinguishes transient work comments from identifiers and fixture strings', () => {
    expect(containsTransientWorkComment('const TODO = "FIXME";')).toBe(false);
    expect(containsTransientWorkComment('const fixture = "// TODO";')).toBe(false);
    expect(containsTransientWorkComment('// TODO: temporary work\nconst value = 1;')).toBe(true);
    expect(containsTransientWorkComment('const value = 1; /* FIXME later */')).toBe(true);
  });

  it('finds static, dynamic, import-type, and import-equals module edges at any depth', () => {
    const sourceFile = source(`
      import value from '../../compiler-types/src/static.js';
      import required = require('../../compiler-types/src/required.js');
      export { value as renamed } from '../../compiler-types/src/exported.js';
      type Referenced = import('../../compiler-types/src/type.js').Referenced;
      async function load() {
        return import('../../compiler-types/src/dynamic.js');
      }
    `);

    expect(collectModuleSpecifiers(sourceFile)).toEqual([
      '../../compiler-types/src/dynamic.js',
      '../../compiler-types/src/exported.js',
      '../../compiler-types/src/required.js',
      '../../compiler-types/src/static.js',
      '../../compiler-types/src/type.js',
    ]);
  });

  it('finds contracts exported through a separate local export list', () => {
    const sourceFile = source(`
      export type Direct = number;
      type Hidden = string;
      interface Shape { value: Hidden }
      const value = 1;
      export type { Hidden };
      export { Shape as PublicShape, value };
    `);

    const localExportNames = collectLocalExportNames(sourceFile);
    const contracts = sourceFile.statements
      .filter((node) => isExportedContractDeclaration(node, sourceFile, localExportNames))
      .map((node) => node.name.text)
      .sort();

    expect([...localExportNames].sort()).toEqual(['Hidden', 'Shape', 'value']);
    expect(contracts).toEqual(['Direct', 'Hidden', 'Shape']);
  });
});

function source(contents: string): ts.SourceFile {
  return ts.createSourceFile('/compiler-package/src/probe.ts', contents, ts.ScriptTarget.Latest, true);
}

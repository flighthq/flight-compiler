import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  collectDescribeNames,
  collectExportedApiDeclarations,
  collectLocalExportNames,
  collectModuleSpecifiers,
  containsTransientWorkComment,
  isCompilerApiFunctionName,
  isDomainTypeScriptFileName,
  isExportedContractDeclaration,
} from './packageHealthAst.js';

describe('package boundary AST analysis', () => {
  it('finds exact describe names without accepting skipped or dynamically named suites', () => {
    const sourceFile = source(`
      describe('createWidget', () => {});
      describe.skip('skipWidget', () => {});
      describe(prefix + 'Widget', () => {});
      describe(\`getWidgetName\`, () => {});
    `);

    expect([...collectDescribeNames(sourceFile)].sort()).toEqual(['createWidget', 'getWidgetName']);
  });

  it('finds direct and aliased exported API declarations without counting private declarations', () => {
    const sourceFile = source(`
      export function createWidget() {}
      function getWidgetName() { return 'widget'; }
      const hidden = 1;
      const hasWidgetValue = true;
      interface Widget { name: string }
      export { getWidgetName as readWidgetName, hasWidgetValue, Widget as PublicWidget };
    `);

    expect(collectExportedApiDeclarations(sourceFile)).toEqual([
      { kind: 'function', name: 'createWidget' },
      { kind: 'value', name: 'hasWidgetValue' },
      { kind: 'type', name: 'PublicWidget' },
      { kind: 'function', name: 'readWidgetName' },
    ]);
  });

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

  it('recognizes verb-first API names with a complete PascalCase type segment', () => {
    expect(isCompilerApiFunctionName('combineCompilerStaticFactAudits')).toBe(true);
    expect(isCompilerApiFunctionName('createHaxeCompilerBackend')).toBe(true);
    expect(isCompilerApiFunctionName('getPackageInventoryRootExportLane')).toBe(true);
    expect(isCompilerApiFunctionName('packageRootExportLane')).toBe(false);
    expect(isCompilerApiFunctionName('create')).toBe(false);
  });

  it('recognizes concept-noun TypeScript file names and rejects function or generic names', () => {
    expect(isDomainTypeScriptFileName('compilerSemanticPatch.ts')).toBe(true);
    expect(isDomainTypeScriptFileName('sourceFingerprint.test.ts')).toBe(true);
    expect(isDomainTypeScriptFileName('applySemanticPatchSet.ts')).toBe(false);
    expect(isDomainTypeScriptFileName('utils.ts')).toBe(false);
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

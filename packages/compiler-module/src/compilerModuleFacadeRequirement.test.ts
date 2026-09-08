import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { hasCompilerModuleFacadeLoweringRequirement } from './compilerModuleFacadeRequirement.js';

describe('hasCompilerModuleFacadeLoweringRequirement', () => {
  it('accepts direct declaration reflections including type declarations and destructuring leaves', () => {
    const module = lowerModule(
      `
        export function read(): number { return 1; }
        export const { value, nested: [leaf], ...rest } = { value: 1, nested: [2], other: 3 };
        export class Box {}
        export enum Choice { first }
        export interface Shape { value: number }
        export type Alias = Shape;
      `,
    );

    expect(hasCompilerModuleFacadeLoweringRequirement(module)).toBe(false);
    expect(hasCompilerModuleFacadeLoweringRequirement({ ...module, exports: [] })).toBe(false);
  });

  it.each([
    "const value = 1; export { value as renamed };",
    "const value = 1; export default value;",
    "export { value } from './value.js';",
    "export * from './value.js';",
    "export * as values from './value.js';",
    "import { value } from './value.js'; export { value };",
    'export default function create(): number { return 1; }',
  ])('requires facade lowering for %s', (source) => {
    expect(hasCompilerModuleFacadeLoweringRequirement(lowerModule(source))).toBe(true);
  });

  it('requires lowering when a local route no longer matches an exported declaration', () => {
    const module = lowerModule('export const value = 1;');
    const renamed = structuredClone(module);
    const hidden = structuredClone(module);
    const typeOnly = structuredClone(module);
    Object.assign(renamed.exports[0]!, { exported: 'other' });
    Object.assign(hidden.declarations[0]!, { exported: false });
    Object.assign(typeOnly.exports[0]!, { typeOnly: true });

    expect(hasCompilerModuleFacadeLoweringRequirement(module)).toBe(false);
    expect(hasCompilerModuleFacadeLoweringRequirement(renamed)).toBe(true);
    expect(hasCompilerModuleFacadeLoweringRequirement(hidden)).toBe(true);
    expect(hasCompilerModuleFacadeLoweringRequirement(typeOnly)).toBe(true);
  });
});

function lowerModule(source: string): IrModule {
  const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lowered = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/module-tests',
    upstreamDirectory: '.',
  });
  if (lowered.diagnostics.length > 0) throw new Error(lowered.diagnostics.map((item) => item.message).join('\n'));
  return lowered.module;
}

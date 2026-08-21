import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { hasIrModuleArrayBindingPattern } from './compilerArrayBindingPatternPresence.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('hasIrModuleArrayBindingPattern', () => {
  it('finds patterns in declarations and nested expression functions and rejects fully normalized false positives', () => {
    const empty = lower('empty.ts', 'export const value = 1;');
    const declaration = lower(
      'declaration.ts',
      'export function read(values: number[]): number { const [first]: number[] = values; return first; }',
    );
    const expression = lower(
      'expression.ts',
      'export const read = (values: number[]): number => { const [first]: number[] = values; return first; };',
    );
    const normalized = lowerIrModuleWithCompilerPasses(declaration, [createCompilerLoweringPassArrayBindingPattern()]);

    expect(hasIrModuleArrayBindingPattern(empty)).toBe(false);
    expect(hasIrModuleArrayBindingPattern(declaration)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(expression)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(normalized)).toBe(false);
  });
});

function lower(file: string, source: string): IrModule {
  const result = lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/math', upstreamDirectory: '/flight' },
  );
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

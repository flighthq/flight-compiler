import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrBindingPattern, IrModule, IrVariable } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { hasIrModuleArrayBindingPattern } from './compilerArrayBindingPatternPresence.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('hasIrModuleArrayBindingPattern', () => {
  it('detects patterns nested inside every declaration, statement, and expression container', () => {
    const classSource = lower(
      'class.ts',
      `
        export class Holder {
          field = (() => { const [x]: [number] = [1]; return x; })();
          constructor() { const [y]: [number] = [2]; y; }
          method(): number { const [z]: [number] = [3]; return z; }
        }
      `,
    );
    const defaultExport = lower('default.ts', 'export default (): number => { const [x]: [number] = [1]; return x; };');
    const forOfSource = lower(
      'forOf.ts',
      'export function read(items: [number][]): void { for (const [x] of items) { x; } }',
    );
    const forInSource = lower(
      'forIn.ts',
      'export function read(input: Record<string, [number]>): void { for (const key in input) { const [x]: [number] = input[key]!; x; } }',
    );
    const ifSource = lower(
      'if.ts',
      'export function read(flag: boolean, values: [number]): number { if (flag) { const [x]: [number] = values; return x; } else { const [y]: [number] = values; return y; } }',
    );
    const switchSource = lower(
      'switch.ts',
      'export function read(mode: number, values: [number]): number { switch (mode) { case 0: { const [x]: [number] = values; return x; } default: { const [y]: [number] = values; return y; } } }',
    );
    const trySource = lower(
      'try.ts',
      'export function read(values: [number]): number { try { const [x]: [number] = values; return x; } catch { const [y]: [number] = [0]; return y; } finally { const [z]: [number] = [0]; z; } }',
    );
    const whileSource = lower(
      'while.ts',
      'export function read(values: [number]): number { let result = 0; while (result < 10) { const [x]: [number] = values; result += x; } return result; }',
    );
    const doSource = lower(
      'do.ts',
      'export function read(values: [number]): number { let result = 0; do { const [x]: [number] = values; result += x; } while (result < 10); return result; }',
    );
    const returnSource = lower(
      'return.ts',
      'export function read(values: [number]): number { return (() => { const [x]: [number] = values; return x; })(); }',
    );

    expect(hasIrModuleArrayBindingPattern(classSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(defaultExport)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(forOfSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(forInSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(ifSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(switchSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(trySource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(whileSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(doSource)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(returnSource)).toBe(true);
  });

  it('detects array patterns nested inside object patterns with computed keys, defaults, and rest', () => {
    const nested = lower(
      'object-nested.ts',
      `
        interface Source { items: [number]; computed: [string]; rest: { nested: [boolean] } }
        export function read(source: Source, key: string): number {
          const { items: [first], [key]: computed, ...rest }: Source = source;
          first; computed; rest;
          return 0;
        }
      `,
    );
    const nestedDefault = lower(
      'object-nested-default.ts',
      `
        interface Cfg { items?: [number] }
        export function read(source: Cfg): number {
          const { items: [first] = [0] }: Cfg = source;
          return first;
        }
      `,
    );

    expect(hasIrModuleArrayBindingPattern(nested)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(nestedDefault)).toBe(true);
  });

  it('finds patterns in declarations and nested expression functions and rejects fully normalized false positives', () => {
    const empty = lower('empty.ts', 'export const value = 1;');
    const declaration = lower(
      'declaration.ts',
      'export function read(values: [number]): number { const [first]: [number] = values; return first; }',
    );
    const expression = lower(
      'expression.ts',
      'export const read = (values: [number]): number => { const [first]: [number] = values; return first; };',
    );
    const normalized = lowerIrModuleWithCompilerPasses(declaration, [createCompilerLoweringPassArrayBindingPattern()]);

    expect(hasIrModuleArrayBindingPattern(empty)).toBe(false);
    expect(hasIrModuleArrayBindingPattern(declaration)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(expression)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(normalized)).toBe(false);
  });

  it('walks object pattern binding and rest properties to find nested array patterns', () => {
    const bindingThenArray = lower(
      'binding-then-array.ts',
      `
        interface Source { name: string; items: [number] }
        export function read(source: Source): number {
          const { name, items: [first] }: Source = source;
          name;
          return first;
        }
      `,
    );
    const noRest = lower(
      'no-rest.ts',
      `
        interface Source { name: string; items: [number] }
        export function read(source: Source): number {
          const { items: [first] }: Source = source;
          return first;
        }
      `,
    );

    expect(hasIrModuleArrayBindingPattern(bindingThenArray)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(noRest)).toBe(true);
  });

  it('detects array patterns through computed keys and rest in object patterns', () => {
    const computed = lower(
      'computed-key.ts',
      `
        export function read(source: Record<string, [number]>, key: string): number {
          const { [key]: [first] } = source;
          return first;
        }
      `,
    );
    const rest = lower(
      'rest-array.ts',
      `
        interface Outer { nested: { items: [number] } }
        export function read(source: Outer): number {
          const { nested: { items: [first] } }: Outer = source;
          return first;
        }
      `,
    );

    expect(hasIrModuleArrayBindingPattern(computed)).toBe(true);
    expect(hasIrModuleArrayBindingPattern(rest)).toBe(true);
  });

  it('detects an array binding pattern in the rest element of an object pattern', () => {
    const source = lower(
      'rest-binding.ts',
      `
        interface Source { name: string; extra: string }
        export function read(source: Source): string {
          const { name, ...rest }: Source = source;
          name;
          rest;
          return name;
        }
      `,
    );

    expect(hasIrModuleArrayBindingPattern(source)).toBe(false);

    const injected = structuredClone(source);
    const fn = injected.declarations.find((declaration) => declaration.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const variableStatement = fn.body[0];
    if (variableStatement?.kind !== 'variable') throw new Error('Expected variable');
    const variable = variableStatement.declarations[0] as IrVariable & { pattern: IrBindingPattern };
    if (variable.pattern?.kind !== 'object') throw new Error('Expected object pattern');
    (variable.pattern as { rest: IrBindingPattern }).rest = {
      elements: [{ binding: variable.pattern.rest!, kind: 'binding', omitted: false, rest: false }],
      kind: 'array',
    } as IrBindingPattern;

    expect(hasIrModuleArrayBindingPattern(injected)).toBe(true);
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

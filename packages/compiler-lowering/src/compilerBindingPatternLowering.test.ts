import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import {
  createCompilerLoweringPassBindingPattern,
  getIrModuleBindingPatternResidualCount,
} from './compilerBindingPatternLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassBindingPattern', () => {
  it('normalizes alternating array and object nesting to arbitrary practical depth', () => {
    const module = lower(
      `
        interface Leaf { value: number }
        export function read(input: [{ rows: [{ leaf: Leaf }] }]): number {
          const [{ rows: [{ leaf: { value } }] }]: [{ rows: [{ leaf: Leaf }] }] = input;
          return value;
        }
      `,
    );
    const pass = createCompilerLoweringPassBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });

    expect(pass).toMatchObject({ idempotent: true, name: 'binding-pattern', runsAfter: [] });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    const simple = lower('export const [value]: [number] = [1];');
    expect(() =>
      lowerIrModuleWithCompilerPasses(simple, [createCompilerLoweringPassArrayBindingPattern(), pass]),
    ).not.toThrow();
    const declaration = output.declarations.find((item) => item.kind === 'function' && item.binding.name === 'read');
    expect(declaration?.kind === 'function' ? JSON.stringify(declaration.body) : '').not.toContain('"pattern"');
  });

  it('normalizes an object nested directly inside an array root', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'export function read(input: [{ value: number }]): number { const [{ value }]: [{ value: number }] = input; return value; }',
      ),
      [createCompilerLoweringPassBindingPattern()],
    );

    expect(createCompilerLoweringPassBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reports invalid through the array verify when array binding patterns remain in the module', () => {
    const module = lower('export const [value]: [number] = [1];');
    const pass = createCompilerLoweringPassBindingPattern();

    expect(pass.verifyIrModule(module)).toMatchObject({ kind: 'invalid' });
  });

  it('throws a stuck-guard failure when pattern residuals do not decrease across a lowering round', () => {
    const module = lower('export const value: number = 1;');
    const stuck = structuredClone(module);
    const binding = {
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      id: 'stuck:binding',
      kind: 'variable' as const,
      line: 1,
      name: 'stuck',
      packageName: module.packageName,
      scope: 'block' as const,
      source: module.source,
      space: 'value' as const,
    };
    (stuck.declarations as unknown[]).push({
      declarationKind: 'const',
      exported: false,
      initializer: { kind: 'literal', value: 0 },
      kind: 'variable',
      mutable: false,
      origin: module.declarations[0]!.origin,
      pattern: { binding, kind: 'binding' },
      type: { kind: 'primitive', name: 'number' },
    } as never);
    const pass = createCompilerLoweringPassBindingPattern();

    expect(getIrModuleBindingPatternResidualCount(stuck)).toBe(1);
    expect(() => pass.lowerIrModule(stuck)).toThrow(expect.objectContaining({ code: 'unsupported-ir' }));
    try {
      pass.lowerIrModule(stuck);
    } catch (error) {
      expect(isCompilerLoweringFailure(error)).toBe(true);
    }
  });

  it('does not mistake user strings containing serialized pattern text for structural residuals', () => {
    const module = lower('export const text = \'"pattern":{"kind":"array"}\';');
    const pass = createCompilerLoweringPassBindingPattern();

    expect(pass.lowerIrModule(module)).toBe(module);
  });

  it('normalizes rest-only array and object shapes through the stronger structural residual guard', () => {
    const module = lower(`
      interface Shape { value: number; other: string }
      export function split(values: [number, number], shape: Shape): number {
        const [...arrayRest]: [number, number] = values;
        const { ...objectRest }: Shape = shape;
        return arrayRest.length + objectRest.value;
      }
    `);
    const pass = createCompilerLoweringPassBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });

    expect(getIrModuleBindingPatternResidualCount(module)).toBe(4);
    expect(getIrModuleBindingPatternResidualCount(output)).toBe(0);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });
});

describe('getIrModuleBindingPatternResidualCount', () => {
  it('counts typed nested pattern nodes without inspecting serialized user values', () => {
    const module = lower(`
      interface Leaf { value: number }
      export function read(input: [{ rows: [{ leaf: Leaf }] }]): number {
        const [{ rows: [{ leaf: { value } }] }]: [{ rows: [{ leaf: Leaf }] }] = input;
        return value;
      }
      export const text = '"pattern":{"kind":"array"}';
    `);
    const lowered = createCompilerLoweringPassBindingPattern().lowerIrModule(module);

    expect(getIrModuleBindingPatternResidualCount(module)).toBe(6);
    expect(getIrModuleBindingPatternResidualCount(lowered)).toBe(0);
  });

  it('traverses declaration, closure, class-member, and default-export containers', () => {
    const module = lower(`
      class Holder {
        field = () => { const [field]: [number] = [1]; return field; };
        constructor() { const [constructed]: [number] = [1]; constructed; }
        method(): number { const [method]: [number] = [1]; return method; }
      }
      function declared(): number { const [value]: [number] = [1]; return value; }
      const closure = () => { const [value]: [number] = [1]; return value; };
      export default () => { const [value]: [number] = [1]; return value; };
    `);

    expect(getIrModuleBindingPatternResidualCount(module)).toBe(12);
    expect(
      getIrModuleBindingPatternResidualCount(createCompilerLoweringPassBindingPattern().lowerIrModule(module)),
    ).toBe(0);
  });
});

function lower(source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/binding/src/nested.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/binding', upstreamDirectory: '/flight' },
  ).module;
}

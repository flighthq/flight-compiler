import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import {
  createCompilerLoweringPassBindingPattern,
  getIrModuleBindingPatternResidualCount,
} from './compilerBindingPatternLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

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

  it('does not mistake user strings containing serialized pattern text for structural residuals', () => {
    const module = lower('export const text = \'"pattern":{"kind":"array"}\';');
    const pass = createCompilerLoweringPassBindingPattern();

    expect(pass.lowerIrModule(module)).toBe(module);
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

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
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

    expect(pass).toMatchObject({ idempotent: true, name: 'array-binding-pattern', runsAfter: [] });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
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
});

function lower(source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/binding/src/nested.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/binding', upstreamDirectory: '/flight' },
  ).module;
}

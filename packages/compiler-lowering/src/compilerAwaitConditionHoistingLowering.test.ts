import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassAwaitConditionHoisting } from './compilerAwaitConditionHoistingLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassAwaitConditionHoisting', () => {
  it('binds a suspending branch condition before the branch that reads it', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'export async function decide(task: Promise<boolean>): Promise<number> { if (await task) { return 1; } return 2; }',
      ),
      [pass],
      { verificationDepth: 'idempotence' },
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[0] : undefined;

    if (wrapper?.kind !== 'block') throw new Error('Expected the branch to be wrapped in a block');
    expect(wrapper.statements[0]).toMatchObject({
      declarations: [{ binding: { name: 'awaitCondition' }, initializer: { kind: 'await' } }],
      kind: 'variable',
    });
    expect(wrapper.statements[1]).toMatchObject({
      condition: { kind: 'identifier', reference: { binding: { name: 'awaitCondition' }, kind: 'binding' } },
      kind: 'if',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('leaves a branch whose condition does not suspend exactly as it was', () => {
    const module = lower(
      'export async function decide(flag: boolean): Promise<number> { if (flag) { return 1; } return 2; }',
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassAwaitConditionHoisting()]);

    expect(output).toEqual(module);
  });

  it('leaves a loop condition alone, because a loop re-evaluates it every iteration', () => {
    // Hoisting a loop condition would evaluate it once and turn a loop into a branch. The state
    // machine settles a loop condition inside the header instead, which is why this pass must not.
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const module = lower(
      'export async function drain(task: Promise<boolean>): Promise<number> { while (await task) { } return 1; }',
    );
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);

    expect(output).toEqual(module);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reaches a branch nested inside blocks, loops, switches, and try bodies', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function nested(task: Promise<boolean>, values: number[]): Promise<void> {
          { if (await task) { values.pop(); } }
          for (const value of values) { if (await task) { values.pop(); } }
          switch (values.length) { case 1: if (await task) { values.pop(); } }
          try { if (await task) { values.pop(); } } finally { if (await task) { values.pop(); } }
        }
      `),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });
});

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/await/src/Await.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/await',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassFinallyAwaitHoisting } from './compilerFinallyAwaitHoistingLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassFinallyAwaitHoisting', () => {
  it('moves a suspending finally after a normally completing protected region', () => {
    const pass = createCompilerLoweringPassFinallyAwaitHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function close(task: Promise<void>, cleanup: Promise<void>): Promise<void> {
          let failed = false;
          try { await task; } catch { failed = true; } finally { await cleanup; }
        }
      `),
      [pass],
      { verificationDepth: 'idempotence' },
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[1] : undefined;

    expect(wrapper).toMatchObject({
      kind: 'block',
      statements: [
        { declarations: [{ binding: { name: 'finallyThrew' }, initializer: { value: false } }] },
        { declarations: [{ binding: { name: 'finallyError' }, initializer: { value: null } }] },
        { catchClause: { binding: { name: 'finallyCaught' } }, kind: 'try' },
        { kind: 'block', statements: [{ expression: { kind: 'await' } }] },
        { condition: { reference: { binding: { name: 'finallyThrew' } } }, kind: 'if' },
      ],
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('uses a separate thrown flag so null and undefined rejections are not mistaken for normal completion', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function close(task: Promise<void>, cleanup: Promise<void>): Promise<void> {
          try { await task; } finally { await cleanup; }
        }
      `),
      [createCompilerLoweringPassFinallyAwaitHoisting()],
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[0] : undefined;

    expect(wrapper).toMatchObject({
      kind: 'block',
      statements: [
        { declarations: [{ binding: { name: 'finallyThrew' } }] },
        { declarations: [{ binding: { name: 'finallyError' } }] },
        {
          catchClause: {
            body: {
              statements: [
                { expression: { left: { reference: { binding: { name: 'finallyError' } } } } },
                { expression: { left: { reference: { binding: { name: 'finallyThrew' } } } } },
              ],
            },
          },
        },
      ],
    });
  });

  it('leaves returns in the protected region for a general completion-carrier lowering', () => {
    const pass = createCompilerLoweringPassFinallyAwaitHoisting();
    const module = lower(`
      export async function close(task: Promise<number>, cleanup: Promise<void>): Promise<number> {
        try { return await task; } finally { await cleanup; }
      }
    `);
    const output = pass.lowerIrModule(module);

    expect(output).toEqual(module);
    expect(pass.verifyIrModule(output)).toEqual({
      kind: 'invalid',
      reason: 'an await expression remains inside a finally handler after hoisting',
    });
  });
});

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/finally-await/src/FinallyAwait.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/finally-await',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassCatchAwaitHoisting } from './compilerCatchAwaitHoistingLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassCatchAwaitHoisting', () => {
  it('hoists the catch body into an if-caught block when it contains an await', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'export async function attempt(task: Promise<number>, backup: Promise<number>): Promise<number> { let result: number = 0; try { result = await task; } catch { result = await backup; } return result; }',
      ),
      [pass],
      { verificationDepth: 'idempotence' },
    );
    const declaration = output.declarations[0];
    const tryWrapper = declaration?.kind === 'function' ? declaration.body.find((s) => s.kind === 'block') : undefined;

    if (tryWrapper?.kind !== 'block') throw new Error('Expected the try to be wrapped in a block');
    expect(tryWrapper.statements[0]).toMatchObject({
      declarations: [{ binding: { name: 'caught' }, initializer: { kind: 'literal', value: false } }],
      kind: 'variable',
    });
    expect(tryWrapper.statements[1]).toMatchObject({ kind: 'try' });
    expect(tryWrapper.statements[2]).toMatchObject({
      condition: { kind: 'identifier', reference: { binding: { name: 'caught' }, kind: 'binding' } },
      kind: 'if',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reports an un-lowered module with await in catch as invalid', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const module = lower(
      'export async function attempt(task: Promise<number>, backup: Promise<number>): Promise<number> { let result: number = 0; try { result = await task; } catch { result = await backup; } return result; }',
    );

    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'an await expression remains inside a catch handler after hoisting',
    });
  });

  it('leaves a catch body without await unchanged', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const module = lower(
      'export async function attempt(task: Promise<number>): Promise<number> { let result: number = 0; try { result = await task; } catch { result = -1; } return result; }',
    );
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);

    expect(output).toEqual(module);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reaches catch bodies inside class methods', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export class Fetcher {
          async fetch(task: Promise<number>, backup: Promise<number>): Promise<number> {
            try { return await task; } catch { return await backup; }
          }
        }
      `),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('recurses into blocks, loops, if-else, and switch bodies', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function deep(task: Promise<number>, backup: Promise<number>, items: number[]): Promise<void> {
          { try { await task; } catch { await backup; } }
          while (true) { try { await task; } catch { await backup; } break; }
          do { try { await task; } catch { await backup; } break; } while (true);
          for (let i = 0; i < 1; i++) { try { await task; } catch { await backup; } }
          for (const item of items) { try { await task; } catch { await backup; } }
          for (const key in items) { try { await task; } catch { await backup; } }
          if (true) { try { await task; } catch { await backup; } } else { try { await task; } catch { await backup; } }
          switch (1) { case 1: try { await task; } catch { await backup; } }
        }
      `),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('wraps the hoisted block inside try-finally when finally is present', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'export async function attempt(task: Promise<number>, backup: Promise<number>, log: number[]): Promise<number> { let result: number = 0; try { result = await task; } catch { result = await backup; } finally { log.push(result); } return result; }',
      ),
      [pass],
    );
    const declaration = output.declarations[0];
    const tryFinally = declaration?.kind === 'function' ? declaration.body.find((s) => s.kind === 'block') : undefined;

    if (tryFinally?.kind !== 'block') throw new Error('Expected the try-finally wrapper');
    const outerTry = tryFinally.statements[0];
    expect(outerTry).toMatchObject({ kind: 'try', finallyBody: { kind: 'block' } });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reaches declaration types that have no catch-await (enum, interface, typeAlias, variable)', () => {
    const pass = createCompilerLoweringPassCatchAwaitHoisting();
    const module = lower(`
      export interface Shape { kind: string; }
      export type Flag = boolean;
      export enum Mode { A, B }
      export const value: number = 1;
    `);
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);

    expect(output).toEqual(module);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });
});

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/catch-await/src/CatchAwait.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/catch-await',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

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
      declarations: [{ binding: { name: 'awaitValue' }, initializer: { kind: 'await' } }],
      kind: 'variable',
    });
    expect(wrapper.statements[1]).toMatchObject({
      condition: { kind: 'identifier', reference: { binding: { name: 'awaitValue' }, kind: 'binding' } },
      kind: 'if',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('binds a leading await before a negated branch condition', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'export async function decide(task: Promise<boolean>): Promise<number> { if (!(await task)) return 1; return 2; }',
      ),
      [createCompilerLoweringPassAwaitConditionHoisting()],
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[0] : undefined;

    expect(wrapper).toMatchObject({
      kind: 'block',
      statements: [
        { declarations: [{ binding: { name: 'awaitValue' }, initializer: { kind: 'await' } }], kind: 'variable' },
        { condition: { kind: 'unary', operand: { kind: 'identifier' } }, kind: 'if' },
      ],
    });
  });

  it('preserves short-circuit evaluation when only the right branch condition suspends', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function decide(skip: boolean, task: Promise<boolean>): Promise<number> {
          if (skip || !(await task)) return 1;
          return 2;
        }
      `),
      [createCompilerLoweringPassAwaitConditionHoisting()],
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[0] : undefined;

    expect(wrapper).toMatchObject({
      kind: 'block',
      statements: [
        { declarations: [{ binding: { name: 'awaitLogicalCondition' }, initializer: { kind: 'identifier' } }] },
        {
          condition: { kind: 'unary', operator: '!' },
          consequent: {
            kind: 'block',
            statements: [
              { declarations: [{ binding: { name: 'awaitValue' }, initializer: { kind: 'await' } }] },
              { expression: { kind: 'assignment', right: { kind: 'unary', operator: '!' } } },
            ],
          },
          kind: 'if',
        },
        { condition: { kind: 'identifier' }, kind: 'if' },
      ],
    });
  });

  it('binds a leading await before evaluating a returned comparison or conditional', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function present(task: Promise<number | null>): Promise<boolean> {
          return (await task) !== null;
        }
        export async function choose(task: Promise<boolean>): Promise<number> {
          return (await task) ? 1 : 2;
        }
      `),
      [createCompilerLoweringPassAwaitConditionHoisting()],
    );

    for (const declaration of output.declarations) {
      if (declaration.kind !== 'function') continue;
      expect(declaration.body).toMatchObject([
        {
          kind: 'block',
          statements: [
            { declarations: [{ binding: { name: 'awaitValue' }, initializer: { kind: 'await' } }] },
            { kind: 'return' },
          ],
        },
      ]);
    }
  });

  it('binds a leading await before reading a property from its settled value', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        interface Outcome { reason: string; }
        export async function reason(task: Promise<Outcome>): Promise<string> {
          return (await task).reason;
        }
      `),
      [createCompilerLoweringPassAwaitConditionHoisting()],
    );
    const declaration = output.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'reason',
    );

    expect(declaration).toMatchObject({
      kind: 'function',
      body: [
        {
          kind: 'block',
          statements: [
            { declarations: [{ binding: { name: 'awaitValue' }, initializer: { kind: 'await' } }] },
            { expression: { kind: 'property', object: { kind: 'identifier' } }, kind: 'return' },
          ],
        },
      ],
    });
  });

  it('reports an un-lowered module with suspending branch conditions as invalid', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const module = lower(
      'export async function decide(task: Promise<boolean>): Promise<number> { if (await task) { return 1; } return 2; }',
    );

    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'a suspending branch condition remains after hoisting',
    });
  });

  it('reaches branches inside class constructors, methods, and declaration-level containers', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const module = lower(`
      export class WithConstructor {
        constructor() {
          if ((null as unknown as Promise<boolean>)) { (null as unknown as number); }
        }
        async method(task: Promise<boolean>): Promise<void> { if (await task) { } }
      }
      export class WithoutConstructor {
        async method(task: Promise<boolean>): Promise<void> { if (await task) { } }
      }
      export interface Descriptor { kind: string; }
      export type Flag = boolean;
      export enum Mode { A, B }
      export const value = 1;
    `);
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('recurses into do-while, for, forIn, for-of, if-else, and try-catch bodies', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function loops(task: Promise<boolean>, items: number[], obj: Record<string, number>): Promise<void> {
          do { if (await task) { break; } } while (true);
          for (let i = 0; i < 10; i++) { if (await task) { break; } }
          for (;;) { if (await task) { break; } break; }
          for (const key in obj) { if (await task) { key; break; } }
          for (const item of items) { if (await task) { item; break; } }
          if (await task) { items.pop(); } else { items.push(0); }
          try { if (await task) { } } catch { if (await task) { } }
        }
      `),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('leaves a branch whose condition does not suspend exactly as it was', () => {
    const module = lower(
      'export async function decide(flag: boolean): Promise<number> { if (flag) { return 1; } return 2; }',
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassAwaitConditionHoisting()]);

    expect(output).toEqual(module);
  });

  it('hoists a conditional await initializer into one shared binding and two branch assignments', () => {
    const pass = createCompilerLoweringPassAwaitConditionHoisting();
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function choose(
          flag: boolean,
          first: Promise<number>,
          second: Promise<number>,
        ): Promise<number> {
          const value = flag ? await first : await second;
          return value;
        }
      `),
      [pass],
      { verificationDepth: 'idempotence' },
    );
    const declaration = output.declarations[0];
    const body = declaration?.kind === 'function' ? declaration.body : undefined;

    expect(body).toMatchObject([
      { declarations: [{ binding: { name: 'value' }, mutable: true }] },
      {
        consequent: { expression: { kind: 'assignment', right: { kind: 'await' } } },
        kind: 'if',
        otherwise: { expression: { kind: 'assignment', right: { kind: 'await' } } },
      },
      { kind: 'return' },
    ]);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
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

  it('lowers a suspending snapshot-array for-of body to indexed task-compatible control flow', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(`
        export async function visit(tasks: Promise<number>[]): Promise<number> {
          let total = 0;
          for (const task of [...tasks]) {
            const value = await task;
            if (value === 0) continue;
            total += value;
          }
          return total;
        }
      `),
      [createCompilerLoweringPassAwaitConditionHoisting()],
    );
    const declaration = output.declarations[0];
    const loop = declaration?.kind === 'function' ? declaration.body[1] : undefined;

    expect(loop).toMatchObject({
      kind: 'block',
      statements: [
        { declarations: [{ binding: { name: 'awaitLoopIterable' }, initializer: { kind: 'array' } }] },
        { declarations: [{ binding: { name: 'awaitLoopIndex' }, initializer: { kind: 'literal', value: 0 } }] },
        {
          body: {
            kind: 'block',
          },
          condition: { kind: 'binary', operator: '<', right: { kind: 'property', name: 'length' } },
          kind: 'while',
        },
      ],
    });
    if (loop?.kind !== 'block' || loop.statements[2]?.kind !== 'while') throw new Error('Expected indexed loop');
    const body = loop.statements[2].body;
    if (body.kind !== 'block') throw new Error('Expected indexed loop body');
    expect(body.statements.slice(0, 2)).toMatchObject([
      { declarations: [{ binding: { name: 'task' }, initializer: { kind: 'element' } }] },
      { expression: { kind: 'unary', operator: '++' }, kind: 'expression' },
    ]);
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

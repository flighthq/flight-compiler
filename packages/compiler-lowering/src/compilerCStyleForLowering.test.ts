import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailureCode,
  IrDeclaration,
  IrModule,
  IrStatement,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassCStyleFor', () => {
  it('preserves initializer scope and normalizes omitted conditions and increments', () => {
    const module = lower(
      'loops.ts',
      `
        export function count(limit: number): number {
          let sum = 0;
          for (let index = 0; index < limit; index++) { sum += index; }
          for (;;) { break; }
          return sum;
        }
      `,
    );
    const snapshot = structuredClone(module);
    const pass = createCompilerLoweringPassCStyleFor();
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);
    const body = getFunctionBody(output, 'count');

    expect(pass).toMatchObject({ idempotent: true, name: 'c-style-for', runsAfter: [] });
    expect(body[1]).toMatchObject({
      kind: 'block',
      statements: [
        {
          declarations: [{ binding: { name: 'index' }, initializer: { kind: 'literal', value: 0 } }],
          kind: 'variable',
        },
        {
          body: {
            kind: 'block',
            statements: [
              {
                kind: 'block',
                statements: [{ expression: { kind: 'assignment', operator: '+=' }, kind: 'expression' }],
              },
              {
                expression: { kind: 'assignment', operator: '+=', right: { kind: 'literal', value: 1 } },
                kind: 'expression',
              },
            ],
          },
          condition: { kind: 'binary', operator: '<' },
          kind: 'while',
        },
      ],
    });
    expect(body[2]).toMatchObject({
      kind: 'block',
      statements: [
        {
          body: { kind: 'block', statements: [{ kind: 'block', statements: [{ kind: 'break' }] }] },
          condition: { kind: 'literal', value: true },
          kind: 'while',
        },
      ],
    });
    expect(module).toEqual(snapshot);
    expect(output).toEqual(lowerIrModuleWithCompilerPasses(module, [pass]));
    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'C-style for statement remains after normalization',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('runs increments before matching continues without capturing nested loops', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'continue.ts',
        `
          export function visit(skip: boolean): void {
            for (let outer = 0; outer < 2; outer++) {
              if (skip) continue;
              while (skip) { continue; }
              for (let inner = 0; inner < 2; inner++) { if (skip) continue; }
              switch (outer) { case 0: continue; }
            }
          }
        `,
      ),
      [createCompilerLoweringPassCStyleFor()],
    );
    const outerBlock = getBlock(getFunctionBody(output, 'visit')[0]);
    const outerWhile = getWhile(outerBlock.statements[1]);
    const outerWhileBody = getBlock(outerWhile.body);
    const sourceBody = getBlock(outerWhileBody.statements[0]);
    const directContinue = getIf(sourceBody.statements[0]);
    const nestedWhile = getWhile(sourceBody.statements[1]);
    const innerBlock = getBlock(sourceBody.statements[2]);
    const innerWhile = getWhile(innerBlock.statements[1]);
    const innerSourceBody = getBlock(getBlock(innerWhile.body).statements[0]);
    const switchStatement = getSwitch(sourceBody.statements[3]);

    expect(directContinue.consequent).toMatchObject({
      kind: 'block',
      statements: [
        { expression: { kind: 'assignment', left: { reference: { binding: { name: 'outer' } } } }, kind: 'expression' },
        { kind: 'continue' },
      ],
    });
    expect(nestedWhile.body).toMatchObject({ kind: 'block', statements: [{ kind: 'continue' }] });
    expect(getIf(innerSourceBody.statements[0]).consequent).toMatchObject({
      kind: 'block',
      statements: [
        { expression: { kind: 'assignment', left: { reference: { binding: { name: 'inner' } } } }, kind: 'expression' },
        { kind: 'continue' },
      ],
    });
    expect(switchStatement.cases[0]?.statements[0]).toMatchObject({
      kind: 'block',
      statements: [
        { expression: { kind: 'assignment', left: { reference: { binding: { name: 'outer' } } } }, kind: 'expression' },
        { kind: 'continue' },
      ],
    });
    expect(outerWhileBody.statements[1]).toMatchObject({
      expression: { kind: 'assignment', left: { reference: { binding: { name: 'outer' } } } },
      kind: 'expression',
    });
    expect(getBlock(innerWhile.body).statements[1]).toMatchObject({
      expression: { kind: 'assignment', left: { reference: { binding: { name: 'inner' } } } },
      kind: 'expression',
    });
  });

  it('walks every declaration, statement, and expression container', () => {
    const module = lower(
      'containers.ts',
      `
        export interface Marker { value: number; }
        export type Alias = number;
        export enum Choice { first }
        export class Empty { declared: number; }
        export class Box {
          field = (() => { for (;;) { break; } return 1; })();
          constructor(callback = () => { for (;;) { break; } }) { for (;;) { break; } }
          method(callback = () => 1): unknown {
            let uninitialized: unknown;
            const values = [1, , ...[2]];
            const record = ({ ...{ callback }, [values[0]]: callback } as object);
            const chosen = callback ? values[0] : values[1];
            do { uninitialized; } while (false);
            for (uninitialized = 0; chosen; !uninitialized) { break; }
            for (let remaining = 1; remaining > 0; --remaining) { break; }
            for (const value of values) { value; }
            for (const key in { callback }) { key; }
            if (chosen) callback(); else record;
            switch (chosen) { case 0: break; default: break; }
            try { new Box(callback); } catch (error) { error; }
            try { /x/.test(\`${'${chosen}'}\`); } finally { record; }
            return function nested() { for (;;) { break; } };
          }
        }
        export let later: unknown;
        const local = 1;
        export { local };
        export function overloaded(value: number): void;
        export function overloaded(value: number = 1): void { value; }
        export const identity = (input: number) => input;
        export const value = () => { for (;;) { break; } };
        export async function resolve(): Promise<void> { await Promise.resolve(); return; }
        export default true ? new Box(() => 1).field : [1, ...[2]];
      `,
    );
    const snapshot = structuredClone(module);
    const pass = createCompilerLoweringPassCStyleFor();
    const output = pass.lowerIrModule(module);

    expect(pass.verifyIrModule(module)).toMatchObject({ kind: 'invalid' });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    expect(module).toEqual(snapshot);
    expect(module).not.toEqual(output);
  });

  it('fails deterministically for empty declaration lists and continues crossing finally', () => {
    const source = lower('malformed.ts', 'export function loop(): void { for (;;) { break; } }');
    const declaration = getFunctionDeclaration(source, 'loop');
    const loop = declaration.body[0];
    if (loop?.kind !== 'for') throw new Error('Expected C-style for statement');
    const malformed: IrModule = {
      ...source,
      declarations: [{ ...declaration, body: [{ ...loop, initializer: [] }] }],
    };
    const crossing = lower(
      'finally.ts',
      'export function loop(): void { for (let index = 0; index < 1; index++) { try { continue; } finally { index; } } }',
    );
    const nested = lower(
      'nested-finally.ts',
      'export function loop(): void { for (let index = 0; index < 1; index++) { try { while (true) { continue; } } finally { index; } } }',
    );

    expectFailure(
      () => lowerIrModuleWithCompilerPasses(malformed, [createCompilerLoweringPassCStyleFor()]),
      'malformed-ir',
    );
    const run = () => lowerIrModuleWithCompilerPasses(crossing, [createCompilerLoweringPassCStyleFor()]);
    expectFailure(run, 'unsupported-ir');
    expectFailure(run, 'unsupported-ir');
    expect(
      createCompilerLoweringPassCStyleFor().verifyIrModule(
        lowerIrModuleWithCompilerPasses(nested, [createCompilerLoweringPassCStyleFor()]),
      ),
    ).toEqual({ kind: 'valid' });
  });
});

function expectFailure(run: () => unknown, code: CompilerLoweringFailureCode): void {
  try {
    run();
    throw new Error('Expected compiler lowering failure');
  } catch (error) {
    expect(isCompilerLoweringFailure(error)).toBe(true);
    expect(error).toMatchObject({ code, kind: 'compiler-lowering', pass: 'c-style-for' });
  }
}

function getBlock(statement: IrStatement | undefined): Extract<IrStatement, { kind: 'block' }> {
  if (statement?.kind !== 'block') throw new Error('Expected block statement');
  return statement;
}

function getFunctionBody(module: Readonly<IrModule>, name: string): readonly IrStatement[] {
  return getFunctionDeclaration(module, name).body;
}

function getFunctionDeclaration(
  module: Readonly<IrModule>,
  name: string,
): Extract<IrDeclaration, { kind: 'function' }> {
  const declaration = module.declarations.find((item) => item.kind === 'function' && item.binding.name === name);
  if (declaration?.kind !== 'function') throw new Error(`Expected function ${name}`);
  return declaration;
}

function getIf(statement: IrStatement | undefined): Extract<IrStatement, { kind: 'if' }> {
  if (statement?.kind !== 'if') throw new Error('Expected if statement');
  return statement;
}

function getSwitch(statement: IrStatement | undefined): Extract<IrStatement, { kind: 'switch' }> {
  if (statement?.kind !== 'switch') throw new Error('Expected switch statement');
  return statement;
}

function getWhile(statement: IrStatement | undefined): Extract<IrStatement, { kind: 'while' }> {
  if (statement?.kind !== 'while') throw new Error('Expected while statement');
  return statement;
}

function lower(file: string, source: string): IrModule {
  const result = lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/math', upstreamDirectory: '/flight' },
  );
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

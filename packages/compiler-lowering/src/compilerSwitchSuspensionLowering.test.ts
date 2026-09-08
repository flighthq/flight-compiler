import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule, IrStatement } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassSwitchFallthrough } from './compilerSwitchFallthroughLowering.js';
import { createCompilerLoweringPassSwitchSuspension } from './compilerSwitchSuspensionLowering.js';
import { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';

describe('createCompilerLoweringPassSwitchSuspension', () => {
  it('binds the subject once and tests it, dropping the breaks the branch form does not need', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, mode: number): Promise<number> {
         let total: number = 0;
         switch (mode) {
           case 1: total = await task; break;
           case 2: total = 20; break;
           default: total = 30;
         }
         return total;
       }`,
      pass,
    );
    const declaration = output.declarations[0];
    const wrapper = declaration?.kind === 'function' ? declaration.body[1] : undefined;

    if (wrapper?.kind !== 'block') throw new Error('Expected the switch to become a block');
    expect(wrapper.statements[0]).toMatchObject({
      declarations: [{ binding: { name: 'switchSubject' }, mutable: false }],
      kind: 'variable',
    });
    expect(wrapper.statements[1]).toMatchObject({
      condition: { operator: '===', semantics: { left: { flow: 'number' }, result: 'boolean' } },
      kind: 'if',
    });
    const consequent = wrapper.statements[1]?.kind === 'if' ? wrapper.statements[1].consequent : undefined;
    expect(consequent?.kind === 'block' && consequent.statements.some((item) => item.kind === 'break')).toBe(false);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('reports a convertible suspending switch as invalid before lowering', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const prepared = lowerIrModuleWithCompilerPasses(
      lower(`export async function pick(task: Promise<number>, mode: number): Promise<number> {
        switch (mode) { case 1: return await task; default: return 0; }
      }`),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );

    expect(pass.verifyIrModule(prepared)).toEqual({
      kind: 'invalid',
      reason: 'a suspending switch remains after branch normalization',
    });
  });

  it('converts cases ending with return and throw, and keeps trailing clauses without break', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, mode: number): Promise<number> {
         switch (mode) {
           case 1: return await task;
           case 2: throw new Error('nope');
           default: { const value = 0; return value; }
         }
       }`,
      pass,
    );
    const fn = output.declarations[0];

    expect(fn?.kind === 'function' && fn.body[0]?.kind).toBe('block');
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('walks suspending switches in class methods, loops, if/else, and try/catch/finally', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export class Handler {
         async method(task: Promise<number>, mode: number): Promise<number> {
           if (mode > 0) {
             switch (mode) { case 1: return await task; default: return 0; }
           } else {
             switch (mode) { case -1: return await task; default: return 0; }
           }
           try {
             switch (mode) { case 2: return await task; default: return 0; }
           } catch {
             switch (mode) { case 3: return await task; default: return 0; }
           } finally {
             mode;
           }
           for (const item of [1]) { switch (item) { case 1: return await task; default: return 0; } }
           return 0;
         }
       }`,
      pass,
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('refuses a suspending switch when the subject domain is unknown', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, value: unknown): Promise<number> {
         switch (value) { case 1: return await task; default: return 0; }
       }`,
      pass,
    );
    const fn = output.declarations[0];

    expect(fn?.kind === 'function' && fn.body[0]?.kind).toBe('switch');
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('converts a switch whose only default is the last case with no explicit break', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, mode: number): Promise<number> {
         switch (mode) {
           case 1: return await task;
           case 2: { const result = await task; return result + 1; }
           default: return 0;
         }
       }`,
      pass,
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('leaves a switch that never suspends as a switch, so target output stays idiomatic', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export function pick(mode: number): number {
         switch (mode) { case 1: return 1; default: return 2; }
       }`,
      pass,
    );
    const declaration = output.declarations[0];

    expect(declaration?.kind === 'function' && declaration.body[0]?.kind).toBe('switch');
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('converts a switch without a default case', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, mode: number): Promise<number> {
         switch (mode) {
           case 1: return await task;
           case 2: return 0;
         }
         return -1;
       }`,
      pass,
    );
    const fn = output.declarations[0];

    expect(fn?.kind === 'function' && fn.body[0]?.kind).toBe('block');
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('accepts a last case with expression-only statements and no explicit break', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export async function pick(task: Promise<number>, mode: number, out: { value: number }): Promise<number> {
         switch (mode) {
           case 1: return await task;
           default: out.value = 0;
         }
         return out.value;
       }`,
      pass,
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('refuses a last case with a nested switch-local break in blocks or conditionals', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const prepared = lowerIrModuleWithCompilerPasses(
      lower(`export async function pick(task: Promise<number>, mode: number): Promise<number> {
        switch (mode) { case 1: return await task; default: return 0; }
      }`),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const fn = prepared.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const sw = fn.body[0];
    if (sw?.kind !== 'switch') throw new Error('Expected switch');

    const makeModule = (lastStatements: IrStatement[]): IrModule => {
      const cloned = structuredClone(sw);
      const cases = [...cloned.cases];
      cases[cases.length - 1] = { statements: lastStatements };
      return { ...prepared, declarations: [{ ...fn, body: [{ ...cloned, cases }] }] };
    };

    const breakInBlock = makeModule([{ kind: 'block', statements: [{ kind: 'break' }] }]);
    const breakInIf = makeModule([
      {
        condition: { kind: 'literal', value: true },
        consequent: { kind: 'break' },
        kind: 'if',
        otherwise: { kind: 'break' },
      },
    ]);
    const breakInIfNoElse = makeModule([
      { condition: { kind: 'literal', value: true }, consequent: { kind: 'break' }, kind: 'if' },
    ]);
    const targetedBreak = makeModule([{ kind: 'break', target: { id: 'outer' } as never }]);
    const ifBreakOnlyInElse = makeModule([
      {
        condition: { kind: 'literal', value: true },
        consequent: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
        kind: 'if',
        otherwise: { kind: 'break' },
      },
    ]);
    const ifNoBreakNoElse = makeModule([
      {
        condition: { kind: 'literal', value: true },
        consequent: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
        kind: 'if',
      },
    ]);
    const noBreak = makeModule([
      {
        condition: { kind: 'literal', value: true },
        consequent: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
        kind: 'if',
      },
      { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
    ]);

    for (const module of [breakInBlock, breakInIf, breakInIfNoElse, ifBreakOnlyInElse]) {
      const result = pass.lowerIrModule(module);
      const resultFn = result.declarations[0];
      expect(resultFn?.kind === 'function' && resultFn.body[0]?.kind).toBe('switch');
    }
    const targetedResult = pass.lowerIrModule(targetedBreak);
    expect(targetedResult.declarations[0]?.kind === 'function' && targetedResult.declarations[0].body[0]?.kind).toBe(
      'block',
    );
    const noBreakResult = pass.lowerIrModule(noBreak);
    expect(noBreakResult.declarations[0]?.kind === 'function' && noBreakResult.declarations[0].body[0]?.kind).toBe(
      'block',
    );
    const ifNoBreakNoElseResult = pass.lowerIrModule(ifNoBreakNoElse);
    expect(
      ifNoBreakNoElseResult.declarations[0]?.kind === 'function' && ifNoBreakNoElseResult.declarations[0].body[0]?.kind,
    ).toBe('block');
  });

  it('walks passthrough declarations and statement containers beside the converted switch', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const output = run(
      `export interface Config { value: number; }
       export type Alias = number;
       export enum Mode { A, B }
       export const constant = 1;
       export class Empty {}
       export class WithConstructor {
         constructor() { }
         async method(task: Promise<number>, mode: number): Promise<number> {
           switch (mode) { case 1: return await task; default: return 0; }
         }
       }
       export async function pick(task: Promise<number>, mode: number): Promise<number> {
         do { switch (mode) { case 1: return await task; default: return 0; } } while (false);
         for (let i = 0; i < 1; i++) { switch (mode) { case 1: return await task; default: return 0; } }
         for (const key in { a: 1 }) { key; switch (mode) { case 1: return await task; default: return 0; } }
         while (false) { switch (mode) { case 1: return await task; default: return 0; } }
         if (mode > 0) { switch (mode) { case 1: return await task; default: return 0; } }
         try { switch (mode) { case 1: return await task; default: return 0; } } finally { mode; }
         try { switch (mode) { case 1: return await task; default: return 0; } } catch { return 0; }
         return 0;
       }`,
      pass,
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('refuses switches with multiple defaults or a default that is not last', () => {
    const pass = createCompilerLoweringPassSwitchSuspension();
    const prepared = lowerIrModuleWithCompilerPasses(
      lower(`export async function pick(task: Promise<number>, mode: number): Promise<number> {
        switch (mode) { case 1: return await task; default: return 0; }
      }`),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const fn = prepared.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const sw = fn.body[0];
    if (sw?.kind !== 'switch') throw new Error('Expected switch');
    const testCase = sw.cases.find((clause) => clause.expression);
    const defaultCase = sw.cases.find((clause) => !clause.expression);
    if (!testCase || !defaultCase) throw new Error('Expected both test and default cases');

    const multiDefault: IrModule = {
      ...prepared,
      declarations: [
        { ...fn, body: [{ ...sw, cases: [testCase, { statements: [{ kind: 'return' }] }, defaultCase] }] },
      ],
    };
    const defaultNotLast: IrModule = {
      ...prepared,
      declarations: [{ ...fn, body: [{ ...sw, cases: [defaultCase, testCase] }] }],
    };

    const multiResult = pass.lowerIrModule(multiDefault);
    expect(multiResult.declarations[0]?.kind === 'function' && multiResult.declarations[0].body[0]?.kind).toBe(
      'switch',
    );
    const notLastResult = pass.lowerIrModule(defaultNotLast);
    expect(notLastResult.declarations[0]?.kind === 'function' && notLastResult.declarations[0].body[0]?.kind).toBe(
      'switch',
    );
  });

  it('leaves a suspending switch it cannot convert, so the refusal names the construct', () => {
    // A case that neither breaks nor leaves would fall through in the branch form, and a labelled
    // switch is a jump target the branch form has no name for.
    const pass = createCompilerLoweringPassSwitchSuspension();
    const labelled = run(
      `export async function pick(task: Promise<number>, mode: number): Promise<number> {
         let total: number = 0;
         outer: switch (mode) { case 1: total = await task; break outer; default: total = 2; }
         return total;
       }`,
      pass,
    );
    const declaration = labelled.declarations[0];

    expect(declaration?.kind === 'function' && declaration.body[1]?.kind).toBe('switch');
    expect(pass.verifyIrModule(labelled)).toEqual({ kind: 'valid' });
  });
});

function run(source: string, pass: ReturnType<typeof createCompilerLoweringPassSwitchSuspension>): IrModule {
  return lowerIrModuleWithCompilerPasses(lower(source), [
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassSwitchFallthrough(),
    pass,
  ]);
}

function lower(source: string): IrModule {
  const sourceFile = ts.createSourceFile('/flight/packages/switch/src/Switch.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/switch',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return result.module;
}

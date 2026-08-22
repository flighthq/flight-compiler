import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
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

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule, IrStatement } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassSwitchFallthrough } from './compilerSwitchFallthroughLowering.js';
import { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';

describe('createCompilerLoweringPassSwitchFallthrough', () => {
  it('duplicates fallthrough suffixes and consumes only final switch-local breaks', () => {
    const pass = createCompilerLoweringPassSwitchFallthrough();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-fallthrough.ts',
        `
          export function classify(value: number): number {
            switch (value) {
              case 1:
              case 2: return 5;
              default: return 0;
            }
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting(), pass],
      { verificationDepth: 'idempotence' },
    );
    const statement = getFunctionSwitch(output);

    expect(pass).toMatchObject({
      idempotent: true,
      name: 'switch-fallthrough',
      runsAfter: ['variable-hoisting'],
    });
    expect(statement.cases).toMatchObject([
      { expression: { value: 1 }, statements: [{ expression: { value: 5 }, kind: 'return' }] },
      { expression: { value: 2 }, statements: [{ expression: { value: 5 }, kind: 'return' }] },
      { statements: [{ expression: { value: 0 }, kind: 'return' }] },
    ]);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('preserves default position while expanding every reachable suffix', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-default.ts',
        `
          export function adjust(value: number): number {
            let total = 0;
            switch (value) {
              case 0: total += 1;
              default: total += 2;
              case 3: total += 4; break;
              case 4: return total;
            }
            return total;
          }
        `,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const statement = getFunctionSwitch(output);

    expect(statement.cases.map((switchCase) => switchCase.statements.length)).toEqual([4, 3, 2, 1]);
    expect(statement.cases[0]?.statements.at(-1)).toEqual({ kind: 'break' });
    expect(statement.cases[1]?.expression).toBeUndefined();
    expect(statement.cases[3]?.statements.at(-1)).toMatchObject({ kind: 'return' });
  });

  it('refuses conditional local breaks explicitly', () => {
    const cases = [
      {
        message: 'switch-local break must be the final direct statement of its clause',
        source:
          'export function read(value: number): number { switch (value) { case 0: if (value) break; return 1; default: return 0; } }',
      },
    ];
    for (const item of cases) {
      const run = (): IrModule =>
        lowerIrModuleWithCompilerPasses(lower('switch-refusal.ts', item.source), [
          createCompilerLoweringPassBindingPattern(),
          createCompilerLoweringPassVariableHoisting(),
          createCompilerLoweringPassSwitchFallthrough(),
        ]);

      try {
        run();
        expect.unreachable('Expected switch fallthrough lowering to refuse the input');
      } catch (error) {
        expect(isCompilerLoweringFailure(error)).toBe(true);
        expect(error).toMatchObject({ code: 'unsupported-ir', message: expect.stringContaining(item.message) });
      }
    }
  });

  it('uses a state machine to preserve one binding identity across fallthrough execution', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-binding-state.ts',
        'export function read(value: number): number { switch (value) { case 0: value += 1; case 1: const local = value; return local; default: return 0; } }',
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'block') {
      throw new Error('Expected state-machine block');
    }
    const [stateDeclaration, selector, machine] = declaration.body[0].statements;

    expect(stateDeclaration).toMatchObject({
      declarations: [{ binding: { name: 'switchFallthroughState', scope: 'block' }, initializer: { value: -1 } }],
      kind: 'variable',
    });
    expect(selector).toMatchObject({ kind: 'switch' });
    expect(machine).toMatchObject({
      body: { cases: [{ expression: { value: 0 } }, { expression: { value: 1 } }, { expression: { value: 2 } }] },
      kind: 'while',
    });
    expect(createCompilerLoweringPassSwitchFallthrough().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('exits the state loop before continuing its enclosing loop and keeps multiple machine identities unique', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-continue.ts',
        `
          export function visit(values: number[]): void {
            for (const value of values) {
              switch (value) { case 0: const local = value; local; case 1: continue; default: break; }
              switch (value) { case 2: const other = value; other; case 3: continue; default: break; }
            }
          }
        `,
      ),
      [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
        createCompilerLoweringPassSwitchFallthrough(),
      ],
    );
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'forOf') {
      throw new Error('Expected for-of function');
    }
    const body = declaration.body[0].body;
    if (body.kind !== 'block') throw new Error('Expected loop body');
    const machines = body.statements.filter((statement) => statement.kind === 'block');
    const identities = machines.map((machine) => {
      const declaration = machine.statements[0];
      if (declaration?.kind !== 'variable' || 'pattern' in declaration.declarations[0]!) {
        throw new Error('Expected state binding');
      }
      return declaration.declarations[0]!.binding.id;
    });

    expect(new Set(identities).size).toBe(2);
    expect(machines).toHaveLength(2);
    expect(machines.every((machine) => machine.statements.at(-1)?.kind === 'if')).toBe(true);
  });
});

function getFunctionSwitch(module: Readonly<IrModule>): Extract<IrStatement, { kind: 'switch' }> {
  const declaration = module.declarations[0];
  if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
  const statement = declaration.body.find((item) => item.kind === 'switch');
  if (statement?.kind !== 'switch') throw new Error('Expected switch statement');
  return statement;
}

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/switch/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/switch', upstreamDirectory: '/flight' },
  ).module;
}

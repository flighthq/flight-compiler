import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule, IrStatement } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
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
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting(), pass],
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
        createCompilerLoweringPassArrayBindingPattern(),
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

  it('refuses conditional local breaks and duplicated binding identities explicitly', () => {
    const cases = [
      {
        message: 'switch-local break must be the final direct statement of its clause',
        source:
          'export function read(value: number): number { switch (value) { case 0: if (value) break; return 1; default: return 0; } }',
      },
      {
        message: 'switch fallthrough across binding introductions requires identity-preserving state-machine lowering',
        source:
          'export function read(value: number): number { switch (value) { case 0: value += 1; case 1: const local = value; return local; default: return 0; } }',
      },
    ];
    for (const item of cases) {
      const run = (): IrModule =>
        lowerIrModuleWithCompilerPasses(lower('switch-refusal.ts', item.source), [
          createCompilerLoweringPassArrayBindingPattern(),
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

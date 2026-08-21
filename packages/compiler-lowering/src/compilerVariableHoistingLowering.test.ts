import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailure,
  IrModule,
  IrNamedVariable,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassVariableHoisting } from './compilerVariableHoistingLowering.js';

describe('createCompilerLoweringPassVariableHoisting', () => {
  it('hoists simple declarations while preserving initializer order and input immutability', () => {
    const module = lower(
      'simple-hoisting.ts',
      `
        export function select(): number {
          var first: number = 1, second: number = first + 1;
          var pending: number;
          var first: number;
          pending = second + 1;
          return pending;
        }
      `,
    );
    const snapshot = structuredClone(module);
    const pass = createCompilerLoweringPassVariableHoisting();
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassArrayBindingPattern(), pass], {
      verificationDepth: 'idempotence',
    });
    const body = getFunctionBody(output, 'select');
    const declarations = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(pass).toMatchObject({
      idempotent: true,
      name: 'variable-hoisting',
      runsAfter: ['array-binding-pattern'],
    });
    expect(declarations).toMatchObject([
      { binding: { name: 'first', scope: 'function' }, initialValue: 'undefined', mutable: true },
      { binding: { name: 'second', scope: 'function' }, initialValue: 'undefined', mutable: true },
      { binding: { name: 'pending', scope: 'function' }, initialValue: 'undefined', mutable: true },
    ]);
    expect(declarations.every((variable) => variable.initializer === undefined)).toBe(true);
    expect(body.slice(1, 4)).toMatchObject([
      { expression: { kind: 'assignment', left: { reference: { binding: declarations[0]?.binding } }, operator: '=' } },
      {
        expression: {
          kind: 'assignment',
          left: { reference: { binding: declarations[1]?.binding } },
          operator: '=',
          right: { kind: 'binary', left: { reference: { binding: declarations[0]?.binding } } },
        },
      },
      {
        expression: {
          kind: 'assignment',
          left: { reference: { binding: declarations[2]?.binding } },
          operator: '=',
        },
      },
    ]);
    expect(module).toEqual(snapshot);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('hoists through nested blocks, balanced branches, switches, and exception regions', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'control-flow-hoisting.ts',
        `
          export function select(flag: boolean, mode: number): number {
            { var nested: number = 1; }
            var branch: number;
            if (flag) branch = 2;
            else branch = 3;
            switch (mode) {
              case 0: { var selected: number = branch; selected; break; }
              default: break;
            }
            var completed: number;
            try { completed = nested + branch; }
            catch { completed = 0; }
            finally { completed += 1; }
            return completed;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'select');
    const declarations = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(declarations.map((variable) => variable.binding.name)).toEqual([
      'nested',
      'branch',
      'selected',
      'completed',
    ]);
    expect(body[1]).toMatchObject({
      kind: 'block',
      statements: [{ expression: { kind: 'assignment', left: { reference: { binding: { name: 'nested' } } } } }],
    });
    expect(body[2]).toMatchObject({ kind: 'if' });
    expect(body[3]).toMatchObject({
      cases: [
        {
          statements: [
            {
              kind: 'block',
              statements: [{ expression: { kind: 'assignment' } }, { kind: 'expression' }, { kind: 'break' }],
            },
          ],
        },
        { statements: [{ kind: 'break' }] },
      ],
      kind: 'switch',
    });
    expect(body[4]).toMatchObject({ finallyBody: { kind: 'block' }, kind: 'try' });
  });

  it('hoists nested functions independently and accepts captures created after initialization', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-function-hoisting.ts',
        `
          export function create(): () => number {
            var outer: number = 1;
            return function read(): number {
              { var inner: number = outer + 1; }
              return inner;
            };
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'create');
    const returned = body[2];
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'function') {
      throw new Error('Expected returned function expression');
    }

    expect(getVariableStatement(body[0]).declarations).toMatchObject([{ binding: { name: 'outer' } }]);
    expect(getVariableStatement(returned.expression.body[0]).declarations).toMatchObject([
      { binding: { name: 'inner' } },
    ]);
    expect(returned.expression.body[1]).toMatchObject({
      kind: 'block',
      statements: [{ expression: { kind: 'assignment', right: { kind: 'binary' } } }],
    });
  });

  it('moves C-style for variable initialization before the loop and composes with control-flow lowering', () => {
    const module = lower(
      'for-hoisting.ts',
      `
        export function total(limit: number): number {
          let total = 0;
          for (var index: number = 0; index < limit; index++) total += index;
          return total + index;
        }
      `,
    );
    const hoisted = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassArrayBindingPattern(),
      createCompilerLoweringPassVariableHoisting(),
    ]);
    const body = getFunctionBody(hoisted, 'total');
    const loop = body[3];

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'index', scope: 'function' } },
    ]);
    expect(getNamedVariable(getVariableStatement(body[0]).declarations[0]).initializer).toBeUndefined();
    expect(body[2]).toMatchObject({
      expression: { kind: 'assignment', left: { reference: { binding: { name: 'index' } } } },
    });
    expect(loop).toMatchObject({ initializer: undefined, kind: 'for' });

    const lowered = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassArrayBindingPattern(),
      createCompilerLoweringPassVariableHoisting(),
      createCompilerLoweringPassCStyleFor(),
    ]);
    expect(getFunctionBody(lowered, 'total')).toMatchObject([
      { declarations: [{ binding: { name: 'index' } }], kind: 'variable' },
      { declarations: [{ binding: { name: 'total' } }], kind: 'variable' },
      { expression: { kind: 'assignment' }, kind: 'expression' },
      { kind: 'block', statements: [{ body: { kind: 'block' }, kind: 'while' }] },
      { kind: 'return' },
    ]);
  });

  it('collects loop initializer declarations before declarations in the loop body', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-order-hoisting.ts',
        `
          export function visit(limit: number): void {
            for (var index = 0; index < limit; index++) {
              var current = index;
              current;
            }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'visit');

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'index' } },
      { binding: { name: 'current' } },
    ]);
    expect(body[1]).toMatchObject({ expression: { left: { reference: { binding: { name: 'index' } } } } });
    expect(body[2]).toMatchObject({
      body: {
        statements: [{ expression: { left: { reference: { binding: { name: 'current' } } } } }, { kind: 'expression' }],
      },
      kind: 'for',
    });
  });

  it('uses distinct block-scoped carriers for function-scoped for-of variables', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-of-hoisting.ts',
        `
          export function visit(first: number[], second: number[]): void {
            for (var value of first) value;
            for (var value of second) { value += 1; }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
      { verificationDepth: 'idempotence' },
    );
    const body = getFunctionBody(output, 'visit');
    const firstLoop = getForOfStatement(body[1]);
    const secondLoop = getForOfStatement(body[2]);
    const firstCarrier = getNamedVariable(firstLoop.variable);
    const secondCarrier = getNamedVariable(secondLoop.variable);

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'value', scope: 'function' }, mutable: true },
    ]);
    expect(firstCarrier).toMatchObject({
      binding: { name: 'variableHoistingIterationValue', scope: 'block' },
      mutable: false,
    });
    expect(secondCarrier).toMatchObject({
      binding: { name: 'variableHoistingIterationValue', scope: 'block' },
      mutable: false,
    });
    expect(firstCarrier.binding.id).not.toBe(secondCarrier.binding.id);
    expect(firstLoop.body).toMatchObject({
      kind: 'block',
      statements: [
        {
          expression: {
            kind: 'assignment',
            left: { reference: { binding: { name: 'value' } } },
            right: { reference: { binding: firstCarrier.binding } },
          },
        },
        { kind: 'expression' },
      ],
    });
  });

  it('uses a block-scoped carrier for function-scoped for-in variables', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-in-hoisting.ts',
        `
          export function visit(values: Record<string, number>): void {
            for (var key in values) { key; }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'visit');
    const loop = getForInStatement(body[1]);
    const carrier = getNamedVariable(loop.variable);

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'key', scope: 'function' }, mutable: true },
    ]);
    expect(carrier).toMatchObject({
      binding: { name: 'variableHoistingIterationValue', scope: 'block' },
      mutable: false,
    });
    expect(loop.body).toMatchObject({
      kind: 'block',
      statements: [
        {
          expression: {
            kind: 'assignment',
            left: { reference: { binding: { name: 'key' } } },
            right: { reference: { binding: carrier.binding } },
          },
        },
        { kind: 'expression' },
      ],
    });
  });

  it('composes iteration carriers with function-scoped array binding leaves', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-of-pattern-hoisting.ts',
        `
          export function visit(values: Array<[number, string]>): void {
            for (var [first, second] of values) { first; second; }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'visit');
    const loop = getForOfStatement(body[1]);

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'first', scope: 'function' } },
      { binding: { name: 'second', scope: 'function' } },
    ]);
    expect(loop.variable).toMatchObject({ binding: { name: 'arrayPatternValue', scope: 'block' } });
    expect(loop.body).toMatchObject({
      kind: 'block',
      statements: [
        { expression: { kind: 'assignment', left: { reference: { binding: { name: 'first' } } } } },
        { expression: { kind: 'assignment', left: { reference: { binding: { name: 'second' } } } } },
        { kind: 'expression' },
        { kind: 'expression' },
      ],
    });
  });

  it('composes after array-pattern lowering without giving destructuring ownership of hoisting', () => {
    const source = lower(
      'pattern-hoisting.ts',
      `
        export function split(values: [number, string, ...boolean[]]): boolean[] {
          var [first, ...[second, ...tail]]: [number, string, ...boolean[]] = values;
          first; second;
          return tail;
        }
      `,
    );
    const arrayPass = createCompilerLoweringPassArrayBindingPattern();
    const patternsLowered = lowerIrModuleWithCompilerPasses(source, [arrayPass]);
    const patternBody = getFunctionBody(patternsLowered, 'split');

    expect(getVariableStatement(patternBody[0]).declarations.map(getNamedVariable)).toMatchObject([
      { binding: { name: 'arrayPatternValue', scope: 'block' } },
      { binding: { name: 'first', scope: 'function' } },
      { binding: { name: 'arrayPatternValue', scope: 'block' } },
      { binding: { name: 'second', scope: 'function' } },
      { binding: { name: 'tail', scope: 'function' } },
    ]);

    const output = lowerIrModuleWithCompilerPasses(source, [arrayPass, createCompilerLoweringPassVariableHoisting()]);
    const body = getFunctionBody(output, 'split');
    const hoisted = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(hoisted.map((variable) => variable.binding.name)).toEqual(['first', 'second', 'tail']);
    expect(body.slice(1, 6)).toMatchObject([
      { declarations: [{ binding: { name: 'arrayPatternValue', scope: 'block' } }], kind: 'variable' },
      { expression: { kind: 'assignment', left: { reference: { binding: { name: 'first' } } } } },
      { declarations: [{ binding: { name: 'arrayPatternValue', scope: 'block' } }], kind: 'variable' },
      { expression: { kind: 'assignment', left: { reference: { binding: { name: 'second' } } } } },
      { expression: { kind: 'assignment', left: { reference: { binding: { name: 'tail' } } } } },
    ]);
  });

  it.each([
    {
      reason:
        'function-scoped variable value may be read before initialization; undefined-preserving lowering is required',
      source: 'export function read(): number { return value; var value: number = 1; }',
    },
    {
      reason:
        'function-scoped variable value may be read before initialization; undefined-preserving lowering is required',
      source: 'export function read(flag: boolean): number { if (flag) { var value: number = 1; } return value; }',
    },
    {
      reason:
        'function-scoped variable value may be read before initialization; undefined-preserving lowering is required',
      source: 'export function read(values: number[]): number { for (var value of values) value; return value; }',
    },
    {
      reason:
        'function-scoped variable key may be read before initialization; undefined-preserving lowering is required',
      source:
        'export function read(values: Record<string, number>): string { for (var key in values) key; return key; }',
    },
    {
      reason:
        'function-scoped variable value may be read before initialization; undefined-preserving lowering is required',
      source:
        'export function read(): () => number { const callback = (): number => value; var value: number = 1; return callback; }',
    },
  ])('refuses unsafe or residual variable semantics explicitly: $reason', ({ reason, source }) => {
    const run = () =>
      lowerIrModuleWithCompilerPasses(lower('unsupported-hoisting.ts', source), [
        createCompilerLoweringPassArrayBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
      ]);

    expectLoweringFailure(run, reason);
    expectLoweringFailure(run, reason);
  });
});

function expectLoweringFailure(run: () => unknown, reason: string): void {
  try {
    run();
    expect.unreachable('Expected variable hoisting to fail');
  } catch (error) {
    expect(isCompilerLoweringFailure(error)).toBe(true);
    expect(error as CompilerLoweringFailure).toMatchObject({
      code: 'unsupported-ir',
      kind: 'compiler-lowering',
      message: expect.stringContaining(reason),
      pass: 'variable-hoisting',
    });
  }
}

function getFunctionBody(module: Readonly<IrModule>, name: string): readonly IrStatement[] {
  const declaration = module.declarations.find((item) => item.kind === 'function' && item.binding.name === name);
  if (declaration?.kind !== 'function') throw new Error(`Expected ${name} function`);
  return declaration.body;
}

function getForInStatement(statement: Readonly<IrStatement> | undefined): Extract<IrStatement, { kind: 'forIn' }> {
  if (statement?.kind !== 'forIn') throw new Error('Expected for-in statement');
  return statement;
}

function getForOfStatement(statement: Readonly<IrStatement> | undefined): Extract<IrStatement, { kind: 'forOf' }> {
  if (statement?.kind !== 'forOf') throw new Error('Expected for-of statement');
  return statement;
}

function getNamedVariable(variable: Readonly<IrVariable> | undefined): IrNamedVariable {
  if (!variable || 'pattern' in variable) throw new Error('Expected named variable');
  return variable;
}

function getVariableStatement(
  statement: Readonly<IrStatement> | undefined,
): Extract<IrStatement, { kind: 'variable' }> {
  if (statement?.kind !== 'variable') throw new Error('Expected variable statement');
  return statement;
}

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/hoisting/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/hoisting', upstreamDirectory: '/flight' },
  ).module;
}

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailure,
  IrExpression,
  IrModule,
  IrNamedVariable,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassBindingPattern } from './compilerBindingPatternLowering.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';
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
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassBindingPattern(), pass], {
      verificationDepth: 'idempotence',
    });
    const body = getFunctionBody(output, 'select');
    const declarations = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(pass).toMatchObject({
      idempotent: true,
      name: 'variable-hoisting',
      runsAfter: ['binding-pattern'],
    });
    expect(declarations).toMatchObject([
      { binding: { name: 'first', scope: 'function' }, initialValue: 'uninitialized', mutable: true },
      { binding: { name: 'second', scope: 'function' }, initialValue: 'uninitialized', mutable: true },
      { binding: { name: 'pending', scope: 'function' }, initialValue: 'uninitialized', mutable: true },
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
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
      createCompilerLoweringPassBindingPattern(),
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
      createCompilerLoweringPassBindingPattern(),
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'visit');
    const loop = getForInStatement(body[1]);
    const carrier = getNamedVariable(loop.variable);

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      {
        binding: { name: 'key', scope: 'function' },
        mutable: true,
        type: { kind: 'primitive', name: 'string' },
      },
    ]);
    expect(carrier).toMatchObject({
      binding: { name: 'variableHoistingIterationValue', scope: 'block' },
      mutable: false,
      type: { kind: 'primitive', name: 'string' },
    });
    expect(loop.body).toMatchObject({
      kind: 'block',
      statements: [
        {
          expression: {
            kind: 'assignment',
            left: { reference: { binding: { name: 'key' } } },
            right: { reference: { binding: carrier.binding } },
            semantics: {
              left: { declared: 'string', flow: 'string' },
              result: 'string',
              right: { declared: 'string', flow: 'string' },
            },
          },
        },
        { kind: 'expression' },
      ],
    });
  });

  it('refuses to over-type an untyped redeclaration from later for-in evidence', () => {
    const run = () =>
      lowerIrModuleWithCompilerPasses(
        lower(
          'for-in-redeclaration-hoisting.ts',
          `
            export function visit(values: Record<string, number>): void {
              var key;
              key = 1;
              for (var key in values) key;
            }
          `,
        ),
        [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
      );

    expectLoweringFailure(run, 'function-scoped variable key has inconsistent redeclaration types');
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
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
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

  it('composes after binding-pattern lowering without giving destructuring ownership of hoisting', () => {
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
    const bindingPass = createCompilerLoweringPassBindingPattern();
    const patternsLowered = lowerIrModuleWithCompilerPasses(source, [bindingPass]);
    const patternBody = getFunctionBody(patternsLowered, 'split');

    expect(getVariableStatement(patternBody[0]).declarations.map(getNamedVariable)).toMatchObject([
      { binding: { name: 'arrayPatternValue', scope: 'block' } },
      { binding: { name: 'first', scope: 'function' } },
      { binding: { name: 'arrayPatternValue', scope: 'block' } },
      { binding: { name: 'second', scope: 'function' } },
      { binding: { name: 'tail', scope: 'function' } },
    ]);

    const output = lowerIrModuleWithCompilerPasses(source, [bindingPass, createCompilerLoweringPassVariableHoisting()]);
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
        'export function read(): number { const callback = (): number => value; var value: number; return callback(); }',
    },
  ])('refuses unsafe or residual variable semantics explicitly: $reason', ({ reason, source }) => {
    const run = () =>
      lowerIrModuleWithCompilerPasses(lower('unsupported-hoisting.ts', source), [
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
      ]);

    expectLoweringFailure(run, reason);
    expectLoweringFailure(run, reason);
  });

  it('compares redeclaration types by canonical structure rather than object key insertion order', () => {
    const module = lower(
      'canonical-redeclaration.ts',
      'export function read(): { value: number } { var result: { value: number } = { value: 1 }; var result: { value: number }; return result; }',
    );
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected redeclaration function');
    const secondStatement = getVariableStatement(declaration.body[1]);
    const second = getNamedVariable(secondStatement.declarations[0]);
    if (second.type?.kind !== 'object') throw new Error('Expected object redeclaration type');
    const reorderedType = { properties: second.type.properties, kind: 'object' } as const;
    const reordered: IrModule = {
      ...module,
      declarations: [
        {
          ...declaration,
          body: [
            declaration.body[0]!,
            {
              ...secondStatement,
              declarations: [{ ...second, type: reorderedType }],
            },
            ...declaration.body.slice(2),
          ],
        },
      ],
    };
    const passes = [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()];
    const output = lowerIrModuleWithCompilerPasses(reordered, passes);
    const inconsistent: IrModule = {
      ...reordered,
      declarations: [
        {
          ...declaration,
          body: [
            declaration.body[0]!,
            {
              ...secondStatement,
              declarations: [{ ...second, type: { kind: 'primitive', name: 'string' } }],
            },
            ...declaration.body.slice(2),
          ],
        },
      ],
    };

    expect(getVariableStatement(getFunctionBody(output, 'read')[0]).declarations).toHaveLength(1);
    expectLoweringFailure(
      () => lowerIrModuleWithCompilerPasses(inconsistent, passes),
      'has inconsistent redeclaration types',
    );
  });

  it('lowers diverse expression kinds in a function body with var hoisting', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'expression-variety.ts',
        `
          export async function diverse(
            items: number[],
            obj: { x: number },
            fn: (n: number) => number,
            task: Promise<number>,
          ): Promise<number> {
            var value: number = 1;
            const awaited = await task;
            const casted = value as number;
            const arr = [value, ...items];
            const result = fn(value);
            const instance = new Error(String(value));
            const ternary = value > 0 ? value : 0;
            const indexed = items[value];
            const prop = obj.x;
            const key = 'z';
            const msg = \`count: \${value}\`;
            const neg = -value;
            const composed = { y: value, [key]: 1, ...obj };
            const pattern = /test/;
            value = result + 1;
            return value;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'diverse');

    expect(getVariableStatement(body[0]).declarations).toMatchObject([
      { binding: { name: 'value', scope: 'function' } },
    ]);
    expect(body.some((statement) => statement.kind === 'return')).toBe(true);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers var in class constructors, methods, field initializers, and default parameters', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-hoisting.ts',
        `
          export class Processor {
            action = (value: number): number => {
              var local: number = value;
              return local;
            };
            constructor(public label: string) {
              var init: number = label.length;
              init;
            }
            process(value: number, limit = 10): number {
              var result: number = value + limit;
              return result;
            }
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const declaration = output.declarations[0];
    if (declaration?.kind !== 'class') throw new Error('Expected class');

    expect(declaration.classConstructor?.body[0]).toMatchObject({ declarations: [{ binding: { name: 'init' } }] });
    const method = declaration.methods[0];
    expect(method?.body[0]).toMatchObject({ declarations: [{ binding: { name: 'result' } }] });
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers var through default exports, diverse for-loop initializers, and try variants', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'loops-and-try.ts',
        `
          export default (): number => {
            var value: number = 1;
            return value;
          };
          export function loops(): number {
            var total: number = 0;
            while (total < 10) { total += 1; }
            do { total -= 1; } while (total > 0);
            for (total += 1; total < 20; total++) { break; }
            for (let i = 0; i < 5; i++) { total += i; }
            for (;;) { total = 1; break; }
            try { total += 1; } finally { total += 2; }
            try { total += 1; } catch { total = 0; }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'loops');

    expect(getVariableStatement(body[0]).declarations).toMatchObject([{ binding: { name: 'total' } }]);
    expect(body.some((statement) => statement.kind === 'while')).toBe(true);
    expect(body.some((statement) => statement.kind === 'do')).toBe(true);
    expect(body.filter((statement) => statement.kind === 'for')).toHaveLength(3);
    expect(body.filter((statement) => statement.kind === 'try')).toHaveLength(2);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('maps diverse variable types to their operator value domains through hoisted assignments', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'type-domains.ts',
        `
          export function typeDomains(
            fn: () => void,
            arr: number[],
            pair: [number, string],
            obj: { x: number },
            namedObj: Error,
          ): void {
            var boolVal: boolean = true;
            var strVal: string = 'hello';
            var numVal: number = 1;
            var nullVal: null = null;
            var undefVal: undefined = undefined;
            var voidVal: void = undefined;
            var literalBool: true = true;
            var literalNum: 42 = 42;
            var literalStr: 'hi' = 'hi' as 'hi';
            var unionSame: 1 | 2 = 1;
            var unionMixed: number | string = 1;
            var fnVal: () => void = fn;
            var arrVal: number[] = arr;
            var tupleVal: [number, string] = pair;
            var objVal: { x: number } = obj;
            var namedVal: Error = namedObj;
            boolVal; strVal; numVal; nullVal; undefVal; voidVal;
            literalBool; literalNum; literalStr;
            unionSame; unionMixed; fnVal; arrVal; tupleVal; objVal; namedVal;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'typeDomains');
    const hoisted = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(hoisted.map((variable) => variable.binding.name)).toEqual([
      'boolVal',
      'strVal',
      'numVal',
      'nullVal',
      'undefVal',
      'voidVal',
      'literalBool',
      'literalNum',
      'literalStr',
      'unionSame',
      'unionMixed',
      'fnVal',
      'arrVal',
      'tupleVal',
      'objVal',
      'namedVal',
    ]);
    expect(hoisted.filter((variable) => variable.initialValue === 'undefined').map((v) => v.binding.name)).toEqual([
      'undefVal',
      'voidVal',
    ]);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('collapses multi-declaration var in a single-statement body into a block', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'collapse-hoisting.ts',
        `
          export function collapse(): number {
            var x: number = 1, y: number = 2;
            do var a: number = 3, b: number = 4; while (false);
            return x + y;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'collapse');

    expect(
      getVariableStatement(body[0])
        .declarations.map(getNamedVariable)
        .map((v) => v.binding.name),
    ).toEqual(['x', 'y', 'a', 'b']);
    const doLoop = body.find((statement) => statement.kind === 'do');
    expect(doLoop?.kind === 'do' && doLoop.body.kind).toBe('block');
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('passes non-default exports unchanged while lowering declarations with var', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'named-export-hoisting.ts',
        `
          function helper(): number { return 1; }
          export { helper };
          export function main(): number {
            var value: number = helper();
            return value;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );

    expect(output.exports.some((exported) => exported.kind !== 'default')).toBe(true);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('refuses immutable function-scoped variables and patterns in iteration or variable statements', () => {
    const module = lower(
      'defensive-hoisting.ts',
      'export function read(): number { var value: number = 1; return value; }',
    );
    const pass = createCompilerLoweringPassVariableHoisting();
    const fn = module.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStatement = fn.body[0];
    if (varStatement?.kind !== 'variable') throw new Error('Expected variable');
    const variable = varStatement.declarations[0];
    if (!variable || 'pattern' in variable) throw new Error('Expected named variable');

    const immutable = structuredClone(module);
    const immutableFn = immutable.declarations[0];
    if (immutableFn?.kind !== 'function') throw new Error('Expected function');
    const immutableVar = immutableFn.body[0];
    if (immutableVar?.kind !== 'variable') throw new Error('Expected variable');
    (immutableVar.declarations[0] as unknown as Record<string, unknown>).mutable = false;
    expectLoweringFailure(() => pass.lowerIrModule(immutable), 'must be mutable');

    const patternVar = structuredClone(module);
    const patternFn = patternVar.declarations[0];
    if (patternFn?.kind !== 'function') throw new Error('Expected function');
    const patternStatement = patternFn.body[0];
    if (patternStatement?.kind !== 'variable') throw new Error('Expected variable');
    (patternStatement.declarations[0] as unknown as Record<string, unknown>).pattern = {
      binding: variable.binding,
      kind: 'binding',
    };
    expectLoweringFailure(() => pass.lowerIrModule(patternVar), 'requires prior binding-pattern normalization');

    const forOfModule = lower(
      'defensive-for-of.ts',
      'export function read(items: number[]): number { for (var value of items) { value; } return 0; }',
    );
    const forOfClone = structuredClone(forOfModule);
    const forOfFn = forOfClone.declarations[0];
    if (forOfFn?.kind !== 'function') throw new Error('Expected function');
    const forOfLoop = forOfFn.body[0];
    if (forOfLoop?.kind !== 'forOf') throw new Error('Expected for-of');
    (forOfLoop.variable as unknown as Record<string, unknown>).pattern = {
      binding: (forOfLoop.variable as { binding: unknown }).binding,
      kind: 'binding',
    };
    expectLoweringFailure(() => pass.lowerIrModule(forOfClone), 'requires prior binding-pattern normalization');

    const forOfInitModule = lower(
      'defensive-for-of-init.ts',
      'export function read(items: number[]): number { for (var value of items) { value; } return 0; }',
    );
    const forOfInitClone = structuredClone(forOfInitModule);
    const initFn = forOfInitClone.declarations[0];
    if (initFn?.kind !== 'function') throw new Error('Expected function');
    const initLoop = initFn.body[0];
    if (initLoop?.kind !== 'forOf') throw new Error('Expected for-of');
    (initLoop.variable as unknown as Record<string, unknown>).initializer = { kind: 'literal', value: 0 };
    expectLoweringFailure(() => pass.lowerIrModule(forOfInitClone), 'cannot have an initializer');
  });

  it('composes with object binding-pattern rest to lower objectRest expressions in a var body', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'object-rest-hoisting.ts',
        `
          interface Shape { x: number; y: string; z: boolean }
          export function objectSplit(input: Shape): number {
            var total: number = 0;
            const { x, ...rest } = input;
            total = x;
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'objectSplit');

    expect(getVariableStatement(body[0]).declarations).toMatchObject([{ binding: { name: 'total' } }]);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers tuple, tupleSpread, and undefinedDefault in the lowering expression walk via IR injection', () => {
    const module = lower('inject-lowering.ts', 'export function loop(): void { var x: number = 1; x; }');
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const ref = { binding: declaration.parameters[0]?.binding ?? { id: 'x', name: 'x' }, kind: 'binding' as const };
    const ident: IrExpression = { kind: 'identifier', reference: ref } as unknown as IrExpression;
    const namedVar = (name: string, init: IrExpression): IrVariable =>
      ({
        binding: { id: name, name },
        initializer: init,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
      }) as unknown as IrVariable;
    (declaration as unknown as { body: IrStatement[] }).body = [
      {
        declarations: [
          namedVar('a', {
            elements: [{ expression: ident, optional: false }, { optional: true }],
            kind: 'tuple',
          } as unknown as IrExpression),
          namedVar('b', {
            kind: 'tupleSpread',
            segments: [
              { expression: ident, kind: 'spread' },
              { element: { expression: ident, optional: false }, kind: 'element' },
              { element: { optional: true }, kind: 'element' },
            ],
            type: { elements: [], kind: 'tuple', readonly: false },
          } as unknown as IrExpression),
          namedVar('c', {
            kind: 'undefinedDefault',
            value: ident,
            fallback: { kind: 'literal', value: 0 },
          } as unknown as IrExpression),
          namedVar('d', {
            excluded: [
              { kind: 'named' as const, name: 'x' },
              { expression: ident, kind: 'computed' as const },
            ],
            kind: 'objectRest',
            object: ident,
            type: { kind: 'unknown', source: 'object' },
          } as unknown as IrExpression),
        ],
        kind: 'variable' as const,
      },
      ...declaration.body,
    ];
    const pass = createCompilerLoweringPassVariableHoisting();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('detects residual through IR-only expression types in the visitor walk', () => {
    const module = lower('visitor-residual.ts', 'export function noop(): void {}');
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const varFn: IrExpression = {
      async: false,
      body: [
        {
          declarations: [{ binding: { id: 'v', name: 'v', scope: 'function' }, mutable: true }],
          kind: 'variable' as const,
        },
      ],
      kind: 'function',
      parameters: [],
      returns: { kind: 'primitive', name: 'void' },
      thisMode: 'lexical',
      typeParameters: [],
    } as unknown as IrExpression;
    const ident: IrExpression = { kind: 'literal', value: 0 };
    const namedVar = (name: string, init: IrExpression): IrVariable =>
      ({
        binding: { id: name, name },
        initializer: init,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
      }) as unknown as IrVariable;
    (declaration as unknown as { body: IrStatement[] }).body = [
      {
        declarations: [
          namedVar('a', {
            elements: [{ expression: varFn, optional: false }],
            kind: 'tuple',
          } as unknown as IrExpression),
          namedVar('b', {
            kind: 'tupleSpread',
            segments: [
              { expression: varFn, kind: 'spread' },
              { element: { expression: varFn, optional: false }, kind: 'element' },
            ],
            type: { elements: [], kind: 'tuple', readonly: false },
          } as unknown as IrExpression),
          namedVar('c', { kind: 'undefinedDefault', value: varFn, fallback: varFn } as unknown as IrExpression),
          namedVar('d', {
            excluded: [{ expression: varFn, kind: 'computed' as const }],
            kind: 'objectRest',
            object: varFn,
            type: { kind: 'unknown', source: 'object' },
          } as unknown as IrExpression),
          namedVar('e', { kind: 'tupleRest', object: varFn, start: 0 } as unknown as IrExpression),
          namedVar('f', { kind: 'tupleSuffix', object: varFn, start: 0, width: 1 } as unknown as IrExpression),
        ],
        kind: 'variable' as const,
      },
    ];
    const pass = createCompilerLoweringPassVariableHoisting();
    expect(pass.verifyIrModule(clone)).toMatchObject({ kind: 'invalid' });
  });

  it('detects binding patterns with computed keys, defaults, and rest as residual', () => {
    const module = lower(
      'var-destructuring.ts',
      `
        interface Source { value?: number; nested: { text: string }; extra: boolean }
        export function read(source: Source, key: string): void {
          var { value = 1, nested: { text }, [key]: computed, ...rest }: Source = source;
          value; text; computed; rest;
        }
      `,
    );
    const pass = createCompilerLoweringPassVariableHoisting();
    expect(pass.verifyIrModule(module)).toMatchObject({ kind: 'invalid' });
  });

  it('detects array binding patterns with holes, defaults, and rest as residual', () => {
    const module = lower(
      'var-array-destructuring.ts',
      `
        export function read(values: [number, string, ...boolean[]]): void {
          var [first, , third = 'fallback', ...remaining]: [number, string, ...boolean[]] = values;
          first; third; remaining;
        }
      `,
    );
    const pass = createCompilerLoweringPassVariableHoisting();
    expect(pass.verifyIrModule(module)).toMatchObject({ kind: 'invalid' });
  });

  it('detects residual in injected object and array patterns with nested structure', () => {
    const module = lower('inject-residual.ts', 'export function read(): void { const x = 1; x; }');
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const binding = (name: string, scope: string) =>
      ({ id: name, name, scope }) as unknown as IrNamedVariable['binding'];
    const objectPattern: IrVariable = {
      initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
      mutable: true,
      pattern: {
        kind: 'object',
        properties: [
          {
            initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
            key: { expression: { kind: 'literal', value: 'key' }, kind: 'computed' } as unknown as {
              expression: IrExpression;
              kind: 'computed';
            },
            pattern: { binding: binding('computed', 'function'), kind: 'binding' },
          },
          {
            key: { kind: 'named', name: 'value' },
            pattern: { binding: binding('value', 'function'), kind: 'binding' },
          },
        ],
        rest: { binding: binding('rest', 'function'), kind: 'binding' },
        scope: 'function',
      },
      type: { kind: 'unknown', source: 'object' },
    } as unknown as IrVariable;
    const arrayPattern: IrVariable = {
      initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
      mutable: true,
      pattern: {
        elements: [
          {
            initializer: { kind: 'literal', value: 42 } as unknown as IrExpression,
            pattern: { binding: binding('first', 'function'), kind: 'binding' },
          },
          undefined,
          { pattern: { binding: binding('third', 'function'), kind: 'binding' } },
        ],
        kind: 'array',
        rest: { binding: binding('tail', 'function'), kind: 'binding' },
        scope: 'function',
      },
      type: { kind: 'unknown', source: 'array' },
    } as unknown as IrVariable;
    (declaration as unknown as { body: IrStatement[] }).body = [
      { declarations: [objectPattern, arrayPattern], kind: 'variable' as const },
      ...declaration.body,
    ];
    const pass = createCompilerLoweringPassVariableHoisting();
    expect(pass.verifyIrModule(clone)).toMatchObject({ kind: 'invalid' });

    const restOnly = structuredClone(module);
    const restFn = restOnly.declarations[0];
    if (restFn?.kind !== 'function') throw new Error('Expected function');
    const restObjVar: IrVariable = {
      initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
      mutable: true,
      pattern: {
        kind: 'object',
        properties: [
          {
            key: { kind: 'named', name: 'x' },
            pattern: { binding: binding('x', 'block'), kind: 'binding' },
          },
        ],
        rest: { binding: binding('restVar', 'function'), kind: 'binding' },
        scope: 'function',
      },
      type: { kind: 'unknown', source: 'object' },
    } as unknown as IrVariable;
    const restArrVar: IrVariable = {
      initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
      mutable: true,
      pattern: {
        elements: [{ pattern: { binding: binding('head', 'block'), kind: 'binding' } }],
        kind: 'array',
        rest: { binding: binding('tailVar', 'function'), kind: 'binding' },
        scope: 'function',
      },
      type: { kind: 'unknown', source: 'array' },
    } as unknown as IrVariable;
    (restFn as unknown as { body: IrStatement[] }).body = [
      { declarations: [restObjVar, restArrVar], kind: 'variable' as const },
      ...restFn.body,
    ];
    expect(pass.verifyIrModule(restOnly)).toMatchObject({ kind: 'invalid' });
  });

  it('lowers block-scoped object and array patterns in a for-loop initializer via direct pass invocation', () => {
    const module = lower('for-pattern.ts', 'export function read(): void { var x: number = 1; x; }');
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const binding = (name: string) => ({ id: name, name, scope: 'block' }) as unknown as IrNamedVariable['binding'];
    const varIdent: IrExpression = {
      kind: 'identifier',
      reference: { binding: binding('source'), kind: 'binding' },
    } as unknown as IrExpression;
    const objectWithRest: IrVariable = {
      initializer: varIdent,
      mutable: false,
      pattern: {
        kind: 'object',
        properties: [
          {
            initializer: { kind: 'literal', value: 0 } as unknown as IrExpression,
            key: { expression: { kind: 'literal', value: 'key' }, kind: 'computed' } as unknown as {
              expression: IrExpression;
              kind: 'computed';
            },
            pattern: { binding: binding('computed'), kind: 'binding' },
          },
          { key: { kind: 'named', name: 'value' }, pattern: { binding: binding('value'), kind: 'binding' } },
        ],
        rest: { binding: binding('rest'), kind: 'binding' },
        scope: 'block',
      },
      type: { kind: 'unknown', source: 'object' },
    } as unknown as IrVariable;
    const objectNoRest: IrVariable = {
      initializer: varIdent,
      mutable: false,
      pattern: {
        kind: 'object',
        properties: [{ key: { kind: 'named', name: 'a' }, pattern: { binding: binding('a'), kind: 'binding' } }],
        scope: 'block',
      },
      type: { kind: 'unknown', source: 'object' },
    } as unknown as IrVariable;
    const arrayWithRest: IrVariable = {
      initializer: varIdent,
      mutable: false,
      pattern: {
        elements: [
          {
            initializer: { kind: 'literal', value: 42 } as unknown as IrExpression,
            pattern: { binding: binding('first'), kind: 'binding' },
          },
          undefined,
          { pattern: { binding: binding('third'), kind: 'binding' } },
        ],
        kind: 'array',
        rest: { binding: binding('tail'), kind: 'binding' },
        scope: 'block',
      },
      type: { kind: 'unknown', source: 'array' },
    } as unknown as IrVariable;
    const arrayNoRest: IrVariable = {
      initializer: varIdent,
      mutable: false,
      pattern: {
        elements: [{ pattern: { binding: binding('only'), kind: 'binding' } }],
        kind: 'array',
        scope: 'block',
      },
      type: { kind: 'unknown', source: 'array' },
    } as unknown as IrVariable;
    const bindingKind: IrVariable = {
      initializer: varIdent,
      mutable: false,
      pattern: { binding: binding('simple'), kind: 'binding' },
      type: { kind: 'unknown', source: 'binding' },
    } as unknown as IrVariable;
    const forLoop: IrStatement = {
      body: { kind: 'block', statements: [] },
      initializer: [objectWithRest, objectNoRest, arrayWithRest, arrayNoRest, bindingKind],
      kind: 'for',
    } as unknown as IrStatement;
    (declaration as unknown as { body: IrStatement[] }).body = [forLoop, ...declaration.body];
    const pass = createCompilerLoweringPassVariableHoisting();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('maps indexedAccess, intersection, and keyof type domains to unknown', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'type-domain-edges.ts',
        `
          export function edgeDomains<T extends { x: number }>(
            inter: T & { y: string },
            keyed: keyof T,
            indexed: T['x'],
          ): void {
            var interVar: T & { y: string } = inter;
            var keyedVar: keyof T = keyed;
            var indexedVar: T['x'] = indexed;
            interVar; keyedVar; indexedVar;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'edgeDomains');
    const hoisted = getVariableStatement(body[0]).declarations.map(getNamedVariable);

    expect(hoisted.every((v) => v.initialValue === 'uninitialized')).toBe(true);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('handles classes without constructors, field parameter properties, and fields without initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-edges.ts',
        `
          export class Minimal {
            label: string = 'default';
          }
          export class WithParamProp {
            constructor(public readonly value: number) {
              var local: number = value;
              local;
            }
          }
          export class NoInit {
            declared!: number;
            method(): void {
              var x: number = 1;
              x;
            }
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('handles function overloads, variable declarations without initializers, and return without expression', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'declaration-edges.ts',
        `
          export let declared: number;
          export function overloaded(x: number): number;
          export function overloaded(x: string): string;
          export function overloaded(x: number | string): number | string {
            var result: number | string = x;
            return result;
          }
          export const staticVar: number = (() => {
            var inner: number = 1;
            return inner;
          })();
          export function earlyReturn(): void {
            var flag: boolean = true;
            if (flag) return;
            flag;
          }
          export function sparseArray(): void {
            var x: number = 1;
            const arr = [x, , x];
            arr;
          }
          export function uninitializedLet(): void {
            let later: number;
            var hoisted: number = 1;
            later = hoisted;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers objectRest with computed excluded keys through composition', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'computed-rest.ts',
        `
          interface Shape { x: number; y: string; z: boolean }
          export function read(input: Shape, key: string): number {
            var total: number = 0;
            const { x, [key]: computed, ...rest } = input;
            total = x + (computed as number);
            return total;
          }
        `,
      ),
      [
        createCompilerLoweringPassObjectBindingPattern(),
        createCompilerLoweringPassBindingPattern(),
        createCompilerLoweringPassVariableHoisting(),
      ],
    );
    const body = getFunctionBody(output, 'read');
    expect(getVariableStatement(body[0]).declarations).toMatchObject([{ binding: { name: 'total' } }]);
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('passes enum and interface declarations through unchanged alongside var lowering', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'enum-alongside-var.ts',
        `
          export enum Status { Active, Inactive }
          export interface Config { value: number }
          export type Label = string;
          export function read(): number {
            var x: number = 1;
            return x;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    expect(output.declarations.find((declaration) => declaration.kind === 'enum')).toMatchObject({
      binding: { name: 'Status' },
      kind: 'enum',
    });
    expect(output.declarations.find((declaration) => declaration.kind === 'interface')).toMatchObject({
      binding: { name: 'Config' },
      kind: 'interface',
    });
    expect(output.declarations.find((declaration) => declaration.kind === 'typeAlias')).toMatchObject({
      binding: { name: 'Label' },
      kind: 'typeAlias',
    });
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('verifies a module with no variable hoisting residual as valid', () => {
    const module = lower('no-residual.ts', 'export function clean(x: number): number { const y = x + 1; return y; }');
    const pass = createCompilerLoweringPassVariableHoisting();
    expect(pass.verifyIrModule(module)).toEqual({ kind: 'valid' });
  });

  it('hoists var initialized with function expression', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'function-expr-init.ts',
        `
          export function create(): () => number {
            var maker: () => number = function (): number { return 1; };
            return maker;
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
    const body = getFunctionBody(output, 'create');
    expect(getNamedVariable(getVariableStatement(body[0]).declarations[0])).toMatchObject({
      binding: { name: 'maker' },
    });
  });

  it('hoists var inside switch case with function expression', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'switch-func-init.ts',
        `
          export function pick(x: number): () => number {
            switch (x) {
              case 1: {
                var handler: () => number = function (): number { return x; };
                return handler;
              }
              default: {
                var fallback: () => number = function (): number { return 0; };
                return fallback;
              }
            }
          }
        `,
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    expect(createCompilerLoweringPassVariableHoisting().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('detects residual in raw var with object and array destructuring before binding-pattern lowering', () => {
    const pass = createCompilerLoweringPassVariableHoisting();
    const objectModule = lower(
      'object-pattern-residual.ts',
      `
        export function extract(values: { x: number; y: string }): void {
          var { x, y }: { x: number; y: string } = values;
          x; y;
        }
      `,
    );
    expect(pass.verifyIrModule(objectModule)).toMatchObject({ kind: 'invalid' });

    const arrayModule = lower(
      'array-pattern-residual.ts',
      `
        export function extract(values: [number, string]): void {
          var [first, second]: [number, string] = values;
          first; second;
        }
      `,
    );
    expect(pass.verifyIrModule(arrayModule)).toMatchObject({ kind: 'invalid' });

    const restObjectModule = lower(
      'rest-object-residual.ts',
      `
        export function extract(values: { x: number; y: string; z: boolean }): void {
          var { x, ...rest }: { x: number; y: string; z: boolean } = values;
          x; rest;
        }
      `,
    );
    expect(pass.verifyIrModule(restObjectModule)).toMatchObject({ kind: 'invalid' });

    const restArrayModule = lower(
      'rest-array-residual.ts',
      `
        export function extract(values: [number, ...string[]]): void {
          var [first, ...rest]: [number, ...string[]] = values;
          first; rest;
        }
      `,
    );
    expect(pass.verifyIrModule(restArrayModule)).toMatchObject({ kind: 'invalid' });
  });

  it('elects observable undefined entry state only for an undefined-bearing variable domain', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'undefined-hoisting.ts',
        'export function read(): number | undefined { return value; var value: number | undefined = 1; }',
      ),
      [createCompilerLoweringPassBindingPattern(), createCompilerLoweringPassVariableHoisting()],
    );
    const body = getFunctionBody(output, 'read');

    expect(getNamedVariable(getVariableStatement(body[0]).declarations[0])).toMatchObject({
      binding: { name: 'value' },
      initialValue: 'undefined',
      type: { kind: 'union', types: [{ kind: 'primitive', name: 'number' }, { kind: 'undefined' }] },
    });
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

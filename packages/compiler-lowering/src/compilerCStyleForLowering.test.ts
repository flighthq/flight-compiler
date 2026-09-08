import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailureCode,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';

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

  it('normalizes only numeric update increments and preserves other discarded expressions', () => {
    const module = lower(
      'increment-boundaries.ts',
      `
        export function update(): void {
          let index = 0;
          for (; index < 2; index += 2) { break; }
          for (; index < 2; +index) { break; }
          for (; index > 0; --index) { break; }
          for (; index < 2; index++) { break; }
        }
      `,
    );
    const declaration = getFunctionDeclaration(module, 'update');
    const numericUpdate = declaration.body[4];
    if (numericUpdate?.kind !== 'for' || numericUpdate.increment?.kind !== 'unary') {
      throw new Error('Expected numeric update loop');
    }
    const bigintModule: IrModule = {
      ...module,
      declarations: [
        {
          ...declaration,
          body: [
            ...declaration.body.slice(0, 4),
            {
              ...numericUpdate,
              increment: {
                ...numericUpdate.increment,
                semantics: {
                  operand: { declared: 'bigint', flow: 'bigint' },
                  result: 'bigint',
                },
              },
            },
          ],
        },
      ],
    };
    const pass = createCompilerLoweringPassCStyleFor();
    const output = pass.lowerIrModule(module);
    const bigintOutput = pass.lowerIrModule(bigintModule);

    expect(getLoopIncrement(getFunctionBody(output, 'update')[1])).toMatchObject({
      kind: 'assignment',
      operator: '+=',
      right: { kind: 'literal', value: 2 },
    });
    expect(getLoopIncrement(getFunctionBody(output, 'update')[2])).toMatchObject({
      kind: 'unary',
      operator: '+',
      semantics: { result: 'number' },
    });
    expect(getLoopIncrement(getFunctionBody(output, 'update')[3])).toMatchObject({
      kind: 'assignment',
      operator: '-=',
    });
    expect(getLoopIncrement(getFunctionBody(output, 'update')[4])).toMatchObject({
      kind: 'assignment',
      operator: '+=',
    });
    expect(getLoopIncrement(getFunctionBody(bigintOutput, 'update')[4])).toMatchObject({
      kind: 'unary',
      operator: '++',
      semantics: { result: 'bigint' },
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
            const [pattern = () => { for (;;) { break; } }] = [];
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

  it.each([
    ['class field', 'export class Fixture { value = () => { for (;;) { break; } }; }'],
    ['constructor parameter', 'export class Fixture { constructor(callback = () => { for (;;) { break; } }) {} }'],
    ['constructor body', 'export class Fixture { constructor() { for (;;) { break; } } }'],
    ['method parameter', 'export class Fixture { method(callback = () => { for (;;) { break; } }): void {} }'],
    ['method body', 'export class Fixture { method(): void { for (;;) { break; } } }'],
    ['function parameter', 'export function fixture(callback = () => { for (;;) { break; } }): void {}'],
    ['function body', 'export function fixture(): void { for (;;) { break; } }'],
    ['variable initializer', 'export const fixture = () => { for (;;) { break; } };'],
    ['array element', 'export const fixture = [() => { for (;;) { break; } }];'],
    ['binary left', 'export const fixture = (() => { for (;;) { break; } }) || (() => undefined);'],
    ['binary right', 'export const fixture = (() => undefined) || (() => { for (;;) { break; } });'],
    ['call callee', 'export const fixture = (() => { for (;;) { break; } })();'],
    ['call argument', 'export const fixture = ((value: unknown) => value)(() => { for (;;) { break; } });'],
    ['cast expression', 'export const fixture = (() => { for (;;) { break; } }) as unknown;'],
    ['conditional condition', 'export const fixture = (() => { for (;;) { break; } }) ? 1 : 0;'],
    ['conditional false branch', 'export const fixture = true ? 1 : (() => { for (;;) { break; } });'],
    ['conditional true branch', 'export const fixture = true ? (() => { for (;;) { break; } }) : 0;'],
    ['element index', 'export const fixture = [0][(() => { for (;;) { break; } }) as unknown as number];'],
    ['element object', 'export const fixture = [() => { for (;;) { break; } }][0];'],
    ['nested function parameter', 'export const fixture = (callback = () => { for (;;) { break; } }): void => {};'],
    ['nested function body', 'export const fixture = (): void => { for (;;) { break; } };'],
    ['nested function expression', 'export const fixture = () => (() => { for (;;) { break; } });'],
    ['computed object key', 'export const fixture = { [(() => { for (;;) { break; } }) as unknown as string]: 0 };'],
    ['computed object value', 'export const fixture = { ["value"]: () => { for (;;) { break; } } };'],
    ['object property', 'export const fixture = { value: () => { for (;;) { break; } } };'],
    ['object spread', 'export const fixture = { ...{ value: () => { for (;;) { break; } } } };'],
    ['property object', 'export const fixture = (() => { for (;;) { break; } }).name;'],
    ['template part', 'export const fixture = `${() => { for (;;) { break; } }}`;'],
    ['unary operand', 'export const fixture = !(() => { for (;;) { break; } });'],
    ['do condition', 'export function fixture(): void { do {} while ((() => { for (;;) { break; } })()); }'],
    ['do body', 'export function fixture(): void { do { for (;;) { break; } } while (false); }'],
    ['while condition', 'export function fixture(): void { while ((() => { for (;;) { break; } })()) {} }'],
    ['while body', 'export function fixture(): void { while (false) { for (;;) { break; } } }'],
    [
      'for-in object',
      'export function fixture(): void { for (const key in (() => { for (;;) { break; } })()) { key; } }',
    ],
    ['for-in body', 'export function fixture(): void { for (const key in {}) { key; for (;;) { break; } } }'],
    [
      'for-of iterable',
      'export function fixture(): void { for (const value of [() => { for (;;) { break; } }]) { value; } }',
    ],
    ['for-of body', 'export function fixture(): void { for (const value of []) { value; for (;;) { break; } } }'],
    ['if condition', 'export function fixture(): void { if ((() => { for (;;) { break; } })()) {} }'],
    ['if consequent', 'export function fixture(): void { if (true) { for (;;) { break; } } }'],
    ['if otherwise', 'export function fixture(): void { if (true) {} else { for (;;) { break; } } }'],
    ['return expression', 'export function fixture(): unknown { return () => { for (;;) { break; } }; }'],
    [
      'switch expression',
      'export function fixture(): void { switch ((() => { for (;;) { break; } })()) { default: break; } }',
    ],
    [
      'switch case expression',
      'export function fixture(value: unknown): void { switch (value) { case (() => { for (;;) { break; } })(): break; } }',
    ],
    ['switch case statement', 'export function fixture(): void { switch (0) { default: for (;;) { break; } } }'],
    ['try body', 'export function fixture(): void { try { for (;;) { break; } } finally {} }'],
    ['catch body', 'export function fixture(): void { try { throw 1; } catch (error) { for (;;) { break; } } }'],
    ['finally body', 'export function fixture(): void { try {} finally { for (;;) { break; } } }'],
    [
      'statement variable initializer',
      'export function fixture(): void { const value = () => { for (;;) { break; } }; value; }',
    ],
    [
      'array binding default initializer',
      'export function fixture(): void { const [value = () => { for (;;) { break; } }] = []; value; }',
    ],
    [
      'array binding rest',
      'export function fixture(): void { const [first, ...rest] = [() => { for (;;) { break; } }]; first; rest; }',
    ],
  ])('detects a residual C-style loop in an isolated %s', (name, source) => {
    const module = lower(`residual-${name.replaceAll(' ', '-')}.ts`, source);

    expect(createCompilerLoweringPassCStyleFor().verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'C-style for statement remains after normalization',
    });
  });

  it('lowers labeled for, forIn, forOf, do, and while loops and handles targeted continues', () => {
    const pass = createCompilerLoweringPassCStyleFor();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'labeled.ts',
        `
          export function labeled(obj: Record<string, number>, items: number[]): void {
            outer: for (let i = 0; i < 2; i++) {
              for (let j = 0; j < 2; j++) {
                if (j > 0) continue outer;
              }
            }
            a: for (const key in obj) { key; break a; }
            b: for (const item of items) { item; break b; }
            c: do { break c; } while (false);
            d: while (false) { break d; }
          }
        `,
      ),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('handles class parameter properties and object destructuring with computed keys and rest', () => {
    const pass = createCompilerLoweringPassCStyleFor();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'patterns.ts',
        `
          export class WithParameterProperty {
            constructor(public value: number) {
              for (;;) { break; }
            }
          }
          export function patterns(
            obj: { a: number; b: string },
            key: string,
          ): void {
            const { a, ...rest } = obj;
            const { [key]: dynamic, b: renamed = (() => { for (;;) { break; } return ''; })() } = obj;
            a; rest; dynamic; renamed;
            for (;;) { break; }
          }
        `,
      ),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('resolves targeted continue across nested for loops and returns undefined for unmatched targets', () => {
    const pass = createCompilerLoweringPassCStyleFor();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-labels.ts',
        `
          export function nested(): void {
            outer: for (let i = 0; i < 2; i++) {
              inner: for (let j = 0; j < 2; j++) {
                continue inner;
              }
            }
          }
        `,
      ),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('marks continue contexts as crossing finally in nested for loops', () => {
    const pass = createCompilerLoweringPassCStyleFor();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-finally.ts',
        `
          export function doubleNested(): void {
            for (let i = 0; i < 2; i++) {
              for (let j = 0; j < 2; j++) {
                try {
                  while (true) { continue; }
                } finally { j; }
              }
            }
          }
        `,
      ),
      [pass],
    );

    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers objectRest expression through object-binding-pattern lowering composition', () => {
    const module = lower(
      'composed-object.ts',
      `
        export function read(source: { value: number; other: boolean }, key: string): number {
          const { value, [key]: computed, ...rest } = source;
          for (let i = 0; i < 1; i++) { break; }
          return value + (computed as number) + (rest.other ? 1 : 0);
        }
      `,
    );
    const partiallyLowered = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassObjectBindingPattern(),
    ]);
    const forPass = createCompilerLoweringPassCStyleFor();
    expect(forPass.verifyIrModule(partiallyLowered)).toMatchObject({ kind: 'invalid' });
    const output = lowerIrModuleWithCompilerPasses(partiallyLowered, [forPass]);
    expect(forPass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers tuple, tupleSpread, tupleRest, and tupleSuffix through direct IR injection', () => {
    const module = lower(
      'inject.ts',
      'export function loop(x: number): void { for (let i = 0; i < 1; i++) { break; } }',
    );
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const ref = { binding: declaration.parameters[0]!.binding };
    const ident: IrExpression = { kind: 'identifier', reference: ref };
    const namedVar = (name: string, initializer: IrExpression): IrVariable => ({
      binding: { id: name, name },
      initializer,
      mutable: false,
      type: { kind: 'intrinsic', name: 'number' },
    });

    declaration.body = [
      {
        declarations: [
          namedVar('a', {
            elements: [{ expression: ident, optional: false }, { optional: true }],
            kind: 'tuple',
          } as IrExpression),
          namedVar('b', {
            kind: 'tupleSpread',
            segments: [
              { expression: ident, kind: 'spread' },
              { element: { expression: ident, optional: false as const }, kind: 'element' },
              { element: { optional: true as const }, kind: 'element' },
            ],
            type: { elements: [], kind: 'tuple' },
          } as IrExpression),
          namedVar('c', { kind: 'tupleRest', object: ident, start: 0 } as IrExpression),
          namedVar('d', { kind: 'tupleSuffix', object: ident, start: 0, width: 1 } as IrExpression),
        ],
        kind: 'variable' as const,
      },
      ...declaration.body,
    ];

    const pass = createCompilerLoweringPassCStyleFor();
    expect(pass.verifyIrModule(clone)).toMatchObject({ kind: 'invalid' });
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('returns continue unchanged when its target is not in the context chain', () => {
    const module = lower(
      'continue-plain.ts',
      'export function loop(): void { for (let i = 0; i < 2; i++) { continue; } }',
    );
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const forStmt = declaration.body[0];
    if (forStmt?.kind !== 'for') throw new Error('Expected for');
    if (forStmt.body.kind !== 'block') throw new Error('Expected block');
    const continueStmt = forStmt.body.statements[0];
    if (continueStmt?.kind !== 'continue') throw new Error('Expected continue');
    (continueStmt as { target?: unknown }).target = { id: 'ghost', name: 'ghost' };

    const pass = createCompilerLoweringPassCStyleFor();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array binding pattern elements with defaults, holes, and rest', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'array-binding-variety.ts',
        `
          export function loop(items: [number, number | undefined, string, ...boolean[]]): number {
            let total = 0;
            for (let i = 0; i < 1; i++) {
              const [first, second = 0, , ...rest]: [number, number | undefined, string, ...boolean[]] = items;
              total += first + second + rest.length;
            }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassCStyleFor()],
    );
    expect(createCompilerLoweringPassCStyleFor().verifyIrModule(output)).toEqual({ kind: 'valid' });
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

function getLoopIncrement(statement: IrStatement | undefined): IrExpression {
  const block = getBlock(statement);
  const loop = getWhile(block.statements.at(-1));
  const body = getBlock(loop.body);
  const increment = body.statements.at(-1);
  if (increment?.kind !== 'expression') throw new Error('Expected loop increment expression');
  return increment.expression;
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

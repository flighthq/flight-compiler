import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailure,
  IrBindingIdentity,
  IrDeclaration,
  IrModule,
  IrNamedVariable,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassArrayBindingPattern', () => {
  it('lowers fixed and nested array bindings with one deterministic temporary per required tuple', () => {
    const module = lower(
      'fixed-patterns.ts',
      `
        export function select(values: [number, number, number], matrix: [[number]], optional: [number?]): number {
          const [first, , second]: [number, number, number] = values;
          let [[nested]]: [[number]] = matrix;
          const [defaulted = first]: [number?] = optional;
          return first + second + nested + defaulted;
        }
      `,
    );
    const snapshot = structuredClone(module);
    const sourceFunction = getFunctionDeclaration(module, 'select');
    const sourceFirst = getPatternLeafBinding(sourceFunction.body[0], 0, 0);
    const sourceSecond = getPatternLeafBinding(sourceFunction.body[0], 0, 2);
    const sourceNested = getNestedPatternLeafBinding(sourceFunction.body[1], 0, 0, 0);
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });
    const body = getFunctionDeclaration(output, 'select').body;
    const fixed = getVariableStatement(body[0]).declarations.map(getNamedVariable);
    const nested = getVariableStatement(body[1]).declarations.map(getNamedVariable);
    const defaulted = getVariableStatement(body[2]).declarations.map(getNamedVariable);

    expect(pass).toMatchObject({ idempotent: true, name: 'array-binding-pattern', runsAfter: [] });
    expect(fixed).toHaveLength(3);
    expect(fixed).toMatchObject([
      {
        binding: { name: 'arrayPatternValue', scope: 'block' },
        initializer: { kind: 'identifier', reference: { binding: sourceFunction.parameters[0]?.binding } },
        mutable: false,
        type: { elements: expect.any(Array), kind: 'tuple' },
      },
      {
        binding: sourceFirst,
        initializer: {
          index: { kind: 'literal', value: 0 },
          kind: 'element',
          object: { reference: { binding: fixed[0]?.binding } },
          semantics: { receivers: ['tuple'] },
        },
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
      },
      {
        binding: sourceSecond,
        initializer: {
          index: { kind: 'literal', value: 2 },
          kind: 'element',
          object: { reference: { binding: fixed[0]?.binding } },
        },
        mutable: false,
      },
    ]);
    expect(nested).toHaveLength(3);
    expect(nested).toMatchObject([
      {
        binding: { name: 'arrayPatternValue' },
        initializer: { reference: { binding: sourceFunction.parameters[1]?.binding } },
        mutable: false,
        type: { elements: [{ type: { kind: 'tuple' } }], kind: 'tuple' },
      },
      {
        binding: { name: 'arrayPatternValue' },
        initializer: {
          index: { value: 0 },
          object: { reference: { binding: nested[0]?.binding } },
        },
        mutable: false,
        type: { elements: [{ type: { kind: 'primitive', name: 'number' } }], kind: 'tuple' },
      },
      {
        binding: sourceNested,
        initializer: {
          index: { value: 0 },
          object: { reference: { binding: nested[1]?.binding } },
        },
        mutable: true,
        type: { kind: 'primitive', name: 'number' },
      },
    ]);
    expect(fixed[0]?.binding.id).not.toBe(nested[0]?.binding.id);
    expect(nested[0]?.binding.id).not.toBe(nested[1]?.binding.id);
    expect(defaulted).toMatchObject([
      {
        binding: { name: 'arrayPatternValue' },
        initializer: { reference: { binding: sourceFunction.parameters[2]?.binding } },
        mutable: false,
        type: { elements: [{ optional: true }], kind: 'tuple' },
      },
      {
        binding: { name: 'defaulted' },
        initializer: {
          fallback: { reference: { binding: sourceFirst } },
          kind: 'undefinedDefault',
          value: {
            index: { value: 0 },
            object: { reference: { binding: defaulted[0]?.binding } },
            semantics: { receivers: ['tuple'] },
          },
        },
        type: { kind: 'primitive', name: 'number' },
      },
    ]);
    expect(fixed[0]?.binding.id).toContain('array-pattern:$.declarations[0].body[0].declarations[0]');
    expect(module).toEqual(snapshot);
    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'array binding pattern remains after normalization',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    expect(lowerIrModuleWithCompilerPasses(module, [pass])).toEqual(output);
  });

  it('uses aggregate pattern evidence while preserving named alias storage', () => {
    const module = lower(
      'alias-pattern.ts',
      `
        type Pair = [number, string];
        export function select(source: Pair): string {
          const [first, second]: Pair = source;
          first;
          return second;
        }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassArrayBindingPattern()]);
    const variables = getVariableStatement(getFunctionDeclaration(output, 'select').body[0]).declarations.map(
      getNamedVariable,
    );

    expect(variables).toMatchObject([
      { binding: { name: 'arrayPatternValue' }, type: { kind: 'named' } },
      { binding: { name: 'first' }, type: { kind: 'primitive', name: 'number' } },
      { binding: { name: 'second' }, type: { kind: 'primitive', name: 'string' } },
    ]);
  });

  it('lowers module and expression-function patterns without exporting synthetic temporaries', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'containers.ts',
        `
          export const [left, right]: [number, number] = [1, 2];
          export const choose = (values: [number]): number => {
            const [first]: [number] = values;
            return first;
          };
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const [temporary, left, right, choose] = output.declarations;
    if (choose?.kind !== 'variable' || 'pattern' in choose || choose.initializer?.kind !== 'function') {
      throw new Error('Expected expression-function declaration');
    }
    const nestedVariables = getVariableStatement(choose.initializer.body[0]).declarations.map(getNamedVariable);

    expect(temporary).toMatchObject({ exported: false, kind: 'variable' });
    expect(left).toMatchObject({ binding: { name: 'left' }, exported: true, kind: 'variable' });
    expect(right).toMatchObject({ binding: { name: 'right' }, exported: true, kind: 'variable' });
    expect(nestedVariables).toMatchObject([
      { binding: { name: 'arrayPatternValue' }, mutable: false },
      { binding: { name: 'first' }, mutable: false },
    ]);
  });

  it('composes default fallback expressions with later control-flow lowering', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'default-control-flow.ts',
        `
          export function choose(values: [(() => void)?]): () => void {
            const [callback = (): void => { for (;;) { break; } }]: [(() => void)?] = values;
            return callback;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern(), createCompilerLoweringPassCStyleFor()],
    );
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'choose').body[0]).declarations.map(
      getNamedVariable,
    );
    const initializer = declarations[1]?.initializer;
    if (initializer?.kind !== 'undefinedDefault' || initializer.fallback.kind !== 'function') {
      throw new Error('Expected lowered default fallback function');
    }

    expect(initializer.fallback.body[0]).toMatchObject({
      kind: 'block',
      statements: [{ body: { kind: 'block' }, condition: { value: true }, kind: 'while' }],
    });
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
    expect(createCompilerLoweringPassCStyleFor().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers defaults for required tuple elements whose type includes undefined', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'required-undefined-default.ts',
        'export function choose(values: [number | undefined]): number { const [value = 3]: [number | undefined] = values; return value; }',
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'choose').body[0]).declarations.map(
      getNamedVariable,
    );

    expect(declarations[1]).toMatchObject({
      binding: { name: 'value' },
      initializer: { fallback: { value: 3 }, kind: 'undefinedDefault' },
      type: { kind: 'primitive', name: 'number' },
    });
  });

  it('lowers nested tuple defaults through a typed single-evaluation temporary', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-default.ts',
        `
          export function choose(optional: [[number]?], required: [[number] | undefined]): number {
            const [[first] = [1]]: [[number]?] = optional;
            const [[second] = [2]]: [[number] | undefined] = required;
            return first + second;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const body = getFunctionDeclaration(output, 'choose').body;
    const optional = getVariableStatement(body[0]).declarations.map(getNamedVariable);
    const required = getVariableStatement(body[1]).declarations.map(getNamedVariable);

    expect(optional).toHaveLength(3);
    expect(optional[1]).toMatchObject({
      initializer: {
        fallback: {
          elements: [{ expression: { value: 1 }, optional: false }],
          kind: 'tuple',
        },
        kind: 'undefinedDefault',
      },
      type: { kind: 'tuple' },
    });
    expect(optional[2]).toMatchObject({ binding: { name: 'first' }, initializer: { kind: 'element' } });
    expect(required[1]).toMatchObject({
      initializer: { fallback: { kind: 'tuple' }, kind: 'undefinedDefault' },
      type: { kind: 'tuple' },
    });
    expect(required[2]).toMatchObject({ binding: { name: 'second' }, initializer: { kind: 'element' } });
  });

  it('lowers an aligned variadic tuple tail without re-evaluating its source', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'rest-tail.ts',
        'export function split(values: [number, ...string[]]): string[] { const [first, ...rest]: [number, ...string[]] = values; first; return rest; }',
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'split').body[0]).declarations.map(
      getNamedVariable,
    );

    expect(declarations).toMatchObject([
      { binding: { name: 'arrayPatternValue' }, initializer: { kind: 'identifier' } },
      { binding: { name: 'first' }, initializer: { index: { value: 0 }, kind: 'element' } },
      {
        binding: { name: 'rest' },
        initializer: {
          kind: 'tupleRest',
          object: { reference: { binding: declarations[0]?.binding } },
          start: 1,
        },
        type: { element: { kind: 'primitive', name: 'string' }, kind: 'array' },
      },
    ]);
  });

  it('lowers named and nested fixed required tuple suffixes without re-evaluating their source', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'fixed-rest.ts',
        `
          export function split(values: [number, string, boolean]): string {
            const [first, ...tail]: [number, string, boolean] = values;
            const [, ...[second, third]]: [number, string, boolean] = values;
            first; tail; third;
            return second;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const body = getFunctionDeclaration(output, 'split').body;
    const named = getVariableStatement(body[0]).declarations.map(getNamedVariable);
    const nested = getVariableStatement(body[1]).declarations.map(getNamedVariable);

    expect(named).toHaveLength(3);
    expect(named[2]).toMatchObject({
      binding: { name: 'tail' },
      initializer: {
        kind: 'tupleSuffix',
        object: { reference: { binding: named[0]?.binding } },
        start: 1,
        width: 2,
      },
      type: { elements: [{ type: { name: 'string' } }, { type: { name: 'boolean' } }], kind: 'tuple' },
    });
    expect(nested).toHaveLength(4);
    expect(nested[1]).toMatchObject({
      binding: { name: 'arrayPatternValue' },
      initializer: {
        kind: 'tupleSuffix',
        object: { reference: { binding: nested[0]?.binding } },
        start: 1,
        width: 2,
      },
      type: { elements: [{ type: { name: 'string' } }, { type: { name: 'boolean' } }], kind: 'tuple' },
    });
    expect(nested[2]).toMatchObject({ binding: { name: 'second' }, initializer: { index: { value: 0 } } });
    expect(nested[3]).toMatchObject({ binding: { name: 'third' }, initializer: { index: { value: 1 } } });
  });

  it('lowers optional and mixed fixed-variadic tuple suffixes without re-evaluating their source', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'mixed-rest.ts',
        `
          export function splitEmpty(values: [number]): [] {
            const [first, ...tail]: [number] = values;
            first;
            return tail;
          }
          export function splitOptional(values: [number, string?]): [string?] {
            const [first, ...tail]: [number, string?] = values;
            first;
            return tail;
          }
          export function splitMixed(values: [number, string, ...boolean[]]): [string, ...boolean[]] {
            const [first, ...tail]: [number, string, ...boolean[]] = values;
            first;
            return tail;
          }
          export function splitNestedMixed(values: [number, string, ...boolean[]]): boolean[] {
            const [, ...[second, ...tail]]: [number, string, ...boolean[]] = values;
            second;
            return tail;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const empty = getVariableStatement(getFunctionDeclaration(output, 'splitEmpty').body[0]).declarations.map(
      getNamedVariable,
    );
    const optional = getVariableStatement(getFunctionDeclaration(output, 'splitOptional').body[0]).declarations.map(
      getNamedVariable,
    );
    const mixed = getVariableStatement(getFunctionDeclaration(output, 'splitMixed').body[0]).declarations.map(
      getNamedVariable,
    );
    const nested = getVariableStatement(getFunctionDeclaration(output, 'splitNestedMixed').body[0]).declarations.map(
      getNamedVariable,
    );

    expect(empty[2]).toMatchObject({
      binding: { name: 'tail' },
      initializer: { kind: 'tupleSuffix', start: 1, width: 0 },
      type: { elements: [], kind: 'tuple' },
    });
    expect(optional[2]).toMatchObject({
      binding: { name: 'tail' },
      initializer: { kind: 'tupleSuffix', start: 1, width: 1 },
      type: { elements: [{ optional: true, type: { name: 'string' } }], kind: 'tuple' },
    });
    expect(mixed[2]).toMatchObject({
      binding: { name: 'tail' },
      initializer: { kind: 'tupleSuffix', start: 1, width: 2 },
      type: {
        elements: [
          { optional: false, rest: false, type: { name: 'string' } },
          {
            optional: false,
            rest: true,
            type: { element: { name: 'boolean' }, kind: 'array' },
          },
        ],
        kind: 'tuple',
      },
    });
    expect(nested).toMatchObject([
      { binding: { name: 'arrayPatternValue' }, initializer: { kind: 'identifier' } },
      {
        binding: { name: 'arrayPatternValue' },
        initializer: { kind: 'tupleSuffix', start: 1, width: 2 },
        type: { elements: [{ rest: false }, { rest: true }], kind: 'tuple' },
      },
      { binding: { name: 'second' }, initializer: { kind: 'element' } },
      { binding: { name: 'tail' }, initializer: { kind: 'tupleRest', start: 1 } },
    ]);
  });

  it('lowers synchronous for-of tuple bindings at the start of each iteration body', () => {
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'iteration.ts',
        `
          type Rows<T> = ReadonlyArray<T>;
          export function visit(rows: Rows<[number?, ...string[]]>, fixed: [number][]): void {
            for (const [head = 1, ...tail] of rows) { head; tail; }
            for (const [value] of fixed) value;
          }
        `,
      ),
      [pass],
    );
    const body = getFunctionDeclaration(output, 'visit').body;
    const variadic = body[0];
    const single = body[1];
    if (variadic?.kind !== 'forOf' || variadic.body.kind !== 'block') {
      throw new Error('Expected variadic for-of block');
    }
    if (single?.kind !== 'forOf' || single.body.kind !== 'block') throw new Error('Expected wrapped for-of block');
    const variadicBindings = getVariableStatement(variadic.body.statements[0]).declarations.map(getNamedVariable);
    const singleBindings = getVariableStatement(single.body.statements[0]).declarations.map(getNamedVariable);

    expect(variadic.variable).toMatchObject({
      binding: { name: 'arrayPatternValue' },
      mutable: false,
      type: { elements: [{ optional: true }, { rest: true }], kind: 'tuple' },
    });
    expect(variadicBindings).toMatchObject([
      { binding: { name: 'head' }, initializer: { kind: 'undefinedDefault' } },
      { binding: { name: 'tail' }, initializer: { kind: 'tupleRest', start: 1 } },
    ]);
    expect(singleBindings).toMatchObject([{ binding: { name: 'value' }, initializer: { kind: 'element' } }]);
    expect(single.body.statements[1]).toMatchObject({ expression: { reference: { binding: { name: 'value' } } } });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it.each([
    {
      reason: 'nested variadic array binding rest requires variadic tuple-tail destructuring lowering',
      source:
        'export function split(values: [number, ...number[]]): number { const [first, ...[second]]: [number, ...number[]] = values; first; return second; }',
    },
    {
      reason: 'array binding lowering requires a statically known tuple type',
      source: 'export const [value]: number[] = [1];',
    },
    {
      reason: 'array binding index 0 requires a present tuple element or default initializer',
      source: 'export const [value]: [number?] = [];',
    },
    {
      reason: 'array binding index 1 requires a present tuple element or default initializer',
      source: 'export const [first, second]: [number] = [1];',
    },
    {
      reason: 'array binding lowering requires a statically known tuple type',
      source: 'export function read(values: number[]): number { const [value] = values; return value; }',
    },
    {
      reason: 'array binding pattern requires an initializer outside iteration statements',
      source: 'export function read(): void { let [value]: [number]; }',
    },
    {
      reason: 'array binding default at index 0 requires distinct null and undefined representations',
      source:
        'export function read(values: [(number | null)?]): number | null { const [value = 1]: [(number | null)?] = values; return value; }',
    },
    {
      reason: 'array binding default at index 0 requires resolved undefined membership',
      source: 'export function read<T>(values: [T]): T { const [value = undefined as T]: [T] = values; return value; }',
    },
    {
      reason: 'forOf array binding lowering requires a statically known element type',
      source: 'export function read(values: any): void { for (const [value] of values) value; }',
    },
    {
      reason: 'array binding lowering requires a statically known tuple type',
      source: 'export function read(values: number[][]): void { for (const [value] of values) value; }',
    },
    {
      reason: 'async forOf array bindings require task-aware iteration destructuring lowering',
      source:
        'export async function read(values: Array<[number]>): Promise<void> { for await (const [value] of values) value; }',
    },
    {
      reason: 'forIn array bindings require iteration destructuring lowering',
      source: 'export function read(values: object): void { for (const [value] in values) value; }',
    },
  ])('refuses residual semantics explicitly: $reason', ({ reason, source }) => {
    const module = lower('unsupported-pattern.ts', source);
    const run = () => lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassArrayBindingPattern()]);

    expectLoweringFailure(run, reason);
    expectLoweringFailure(run, reason);
  });
});

function expectLoweringFailure(run: () => unknown, reason: string): void {
  try {
    run();
    expect.unreachable('Expected array binding lowering to fail');
  } catch (error) {
    expect(isCompilerLoweringFailure(error)).toBe(true);
    expect(error as CompilerLoweringFailure).toMatchObject({
      code: 'unsupported-ir',
      kind: 'compiler-lowering',
      message: expect.stringContaining(reason),
      pass: 'array-binding-pattern',
    });
  }
}

function getFunctionDeclaration(
  module: Readonly<IrModule>,
  name: string,
): Extract<IrDeclaration, { kind: 'function' }> {
  const declaration = module.declarations.find((item) => item.kind === 'function' && item.binding.name === name);
  if (declaration?.kind !== 'function') throw new Error(`Expected function ${name}`);
  return declaration;
}

function getNestedPatternLeafBinding(
  statement: Readonly<IrStatement> | undefined,
  declarationIndex: number,
  elementIndex: number,
  nestedIndex: number,
): IrBindingIdentity {
  const variable = getVariableStatement(statement).declarations[declarationIndex];
  if (!variable || !('pattern' in variable) || variable.pattern.kind !== 'array') {
    throw new Error('Expected array pattern variable');
  }
  const nested = variable.pattern.elements[elementIndex]?.pattern;
  if (nested?.kind !== 'array') throw new Error('Expected nested array pattern');
  const leaf = nested.elements[nestedIndex]?.pattern;
  if (leaf?.kind !== 'binding') throw new Error('Expected nested pattern binding');
  return leaf.binding;
}

function getNamedVariable(variable: Readonly<IrVariable>): IrNamedVariable {
  if ('pattern' in variable) throw new Error('Expected named variable');
  return variable;
}

function getPatternLeafBinding(
  statement: Readonly<IrStatement> | undefined,
  declarationIndex: number,
  elementIndex: number,
): IrBindingIdentity {
  const variable = getVariableStatement(statement).declarations[declarationIndex];
  if (!variable || !('pattern' in variable) || variable.pattern.kind !== 'array') {
    throw new Error('Expected array pattern variable');
  }
  const leaf = variable.pattern.elements[elementIndex]?.pattern;
  if (leaf?.kind !== 'binding') throw new Error('Expected pattern binding');
  return leaf.binding;
}

function getVariableStatement(
  statement: Readonly<IrStatement> | undefined,
): Extract<IrStatement, { kind: 'variable' }> {
  if (statement?.kind !== 'variable') throw new Error('Expected variable statement');
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

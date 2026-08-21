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
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassArrayBindingPattern', () => {
  it('lowers fixed and nested array bindings with one deterministic temporary per evaluated array', () => {
    const module = lower(
      'fixed-patterns.ts',
      `
        export function select(values: number[], matrix: number[][]): number {
          const [first, , second]: number[] = values;
          let [[nested]]: number[][] = matrix;
          return first + second + nested;
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

    expect(pass).toMatchObject({ idempotent: true, name: 'array-binding-pattern', runsAfter: [] });
    expect(fixed).toHaveLength(3);
    expect(fixed).toMatchObject([
      {
        binding: { name: 'arrayPatternValue', scope: 'block' },
        initializer: { kind: 'identifier', reference: { binding: sourceFunction.parameters[0]?.binding } },
        mutable: false,
        type: { element: { kind: 'primitive', name: 'number' }, kind: 'array' },
      },
      {
        binding: sourceFirst,
        initializer: {
          index: { kind: 'literal', value: 0 },
          kind: 'element',
          object: { reference: { binding: fixed[0]?.binding } },
          semantics: { receivers: ['array'] },
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
        type: { element: { kind: 'array' }, kind: 'array' },
      },
      {
        binding: { name: 'arrayPatternValue' },
        initializer: {
          index: { value: 0 },
          object: { reference: { binding: nested[0]?.binding } },
        },
        mutable: false,
        type: { element: { kind: 'primitive', name: 'number' }, kind: 'array' },
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
    expect(fixed[0]?.binding.id).toContain('array-pattern:$.declarations[0].body[0].declarations[0]');
    expect(module).toEqual(snapshot);
    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'array binding pattern remains after normalization',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
    expect(lowerIrModuleWithCompilerPasses(module, [pass])).toEqual(output);
  });

  it('lowers module and expression-function patterns without exporting synthetic temporaries', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'containers.ts',
        `
          export const [left, right]: number[] = [1, 2];
          export const choose = (values: number[]): number => {
            const [first]: number[] = values;
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

  it.each([
    {
      reason: 'array binding default at index 0 requires target-neutral undefined semantics',
      source: 'export const [value = 0]: number[] = [];',
    },
    {
      reason: 'array binding rest requires target-neutral slice semantics',
      source: 'export const [first, ...rest]: number[] = [];',
    },
    {
      reason: 'array binding lowering requires a statically known array type',
      source: 'export const [value]: [number] = [1];',
    },
    {
      reason: 'array binding lowering requires a statically known array type',
      source: 'export function read(values: number[]): number { const [value] = values; return value; }',
    },
    {
      reason: 'function-scoped array binding patterns require variable-hoisting lowering',
      source: 'export function read(values: number[]): number { var [value]: number[] = values; return value; }',
    },
    {
      reason: 'array binding pattern requires an initializer outside iteration statements',
      source: 'export function read(): void { let [value]: number[]; }',
    },
    {
      reason: 'forOf array bindings require iteration destructuring lowering',
      source: 'export function read(values: number[][]): void { for (const [value] of values) value; }',
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

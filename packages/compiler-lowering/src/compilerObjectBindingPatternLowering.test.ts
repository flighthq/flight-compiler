import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrFunctionDeclaration, IrModule, IrStatement } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';

describe('createCompilerLoweringPassObjectBindingPattern', () => {
  it('lowers named, computed, defaulted, nested, and rest properties in source order with one evaluation', () => {
    const module = lower(
      'object-pattern.ts',
      `
        type Shape = { value?: number; nested: { text: string }; other: boolean };
        export function select(source: Shape, key: string): string {
          const { value = 1, nested: { text }, [key]: computed, ...rest }: Shape = source;
          return text + value + computed + rest.other;
        }
      `,
    );
    const snapshot = structuredClone(module);
    const pass = createCompilerLoweringPassObjectBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });
    const statement = getVariableStatement(getFunction(output).body[0]);

    expect(pass).toMatchObject({ idempotent: true, name: 'object-binding-pattern', runsAfter: [] });
    expect(statement.declarations).toMatchObject([
      {
        binding: { name: 'objectPatternValue' },
        initializer: { reference: { binding: getFunction(module).parameters[0]?.binding } },
      },
      {
        binding: { name: 'value' },
        initializer: { kind: 'undefinedDefault', value: { kind: 'property', name: 'value' } },
      },
      { binding: { name: 'objectPatternValue' }, initializer: { kind: 'property', name: 'nested' } },
      { binding: { name: 'text' }, initializer: { kind: 'property', name: 'text' } },
      {
        binding: { name: 'objectPatternKey' },
        initializer: { reference: { binding: getFunction(module).parameters[1]?.binding } },
      },
      { binding: { name: 'computed' }, initializer: { kind: 'element', semantics: { receivers: ['object'] } } },
      {
        binding: { name: 'rest' },
        initializer: {
          excluded: [
            { kind: 'named', name: 'value' },
            { kind: 'named', name: 'nested' },
            { expression: { reference: { binding: { name: 'objectPatternKey' } } }, kind: 'computed' },
          ],
          kind: 'objectRest',
        },
      },
    ]);
    expect(
      new Set(statement.declarations.flatMap((variable) => ('binding' in variable ? [variable.binding.id] : []))).size,
    ).toBe(7);
    expect(module).toEqual(snapshot);
  });

  it('composes object-then-array lowering and leaves inverse nesting for the unified pass', () => {
    const objectThenArray = lower(
      'object-array.ts',
      `
        export function select(source: { tuple: [number] }): number {
          const { tuple: [value] }: { tuple: [number] } = source;
          return value;
        }
      `,
    );
    const arrayThenObject = lower(
      'array-object.ts',
      `
        export function select(source: [{ value: number }]): number {
          const [{ value }]: [{ value: number }] = source;
          return value;
        }
      `,
    );

    const output = lowerIrModuleWithCompilerPasses(objectThenArray, [
      createCompilerLoweringPassObjectBindingPattern(),
      createCompilerLoweringPassArrayBindingPattern(),
    ]);
    expect(getVariableStatement(getFunction(output).body[0]).declarations).toMatchObject([
      { binding: { name: 'objectPatternValue' } },
      { binding: { name: 'arrayPatternValue' } },
      { binding: { name: 'value' } },
    ]);
    const objectPass = createCompilerLoweringPassObjectBindingPattern();
    const partial = objectPass.lowerIrModule(arrayThenObject);
    expect(objectPass.verifyIrModule(partial)).toEqual({
      kind: 'invalid',
      reason: 'object binding pattern remains after normalization',
    });
  });

  it('refuses defaults without resolved and distinct undefined evidence', () => {
    const nullable = lower(
      'nullable-default.ts',
      `
        export function select(source: { value?: number | null }): number {
          const { value = 1 }: { value?: number | null } = source;
          return value;
        }
      `,
    );
    const unknown = lower(
      'unknown-default.ts',
      `
        export function select(source: any): number {
          const { value = 1 } = source;
          return value;
        }
      `,
    );

    for (const [module, message] of [
      [nullable, 'requires distinct null and undefined representations'],
      [unknown, 'requires resolved undefined membership'],
    ] as const) {
      expect(() => lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassObjectBindingPattern()])).toThrow(
        message,
      );
    }
  });
});

function getFunction(module: Readonly<IrModule>): IrFunctionDeclaration {
  const declaration = module.declarations.find((item) => item.kind === 'function');
  if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
  return declaration;
}

function getVariableStatement(
  statement: Readonly<IrStatement> | undefined,
): Extract<IrStatement, { kind: 'variable' }> {
  if (statement?.kind !== 'variable') throw new Error('Expected variable statement');
  return statement;
}

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/lowering/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/lowering', upstreamDirectory: '/flight' },
  ).module;
}

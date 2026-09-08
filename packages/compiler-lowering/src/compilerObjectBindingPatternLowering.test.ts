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

  it('lowers object patterns in diverse statement containers and expression kinds', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'statement-variety.ts',
        `
          export function diverse(
            source: { x: number; y: string },
            items: Array<{ a: number }>,
            obj: Record<string, number>,
            flag: boolean,
            fn: (n: number) => number,
          ): number {
            const { x, y } = source;
            { x; }
            if (flag) { x; } else { y; }
            while (false) { x; }
            do { x; } while (false);
            for (let i = 0; i < 1; i++) { x; }
            for (const key in obj) { key; }
            switch (x) { case 0: x; break; default: y; break; }
            try { x; } catch { y; } finally { x; }
            try { x; } finally { x; }
            try { x; } catch { y; }
            const arr = [x, ...items.map((i) => i.a)];
            const msg = \`\${x} \${y}\`;
            const ternary = flag ? x : 0;
            const neg = -x;
            const composed = { a: x, [y]: 1, ...source };
            const prop = source.x;
            const indexed = items[x];
            const called = fn(x);
            const instance = new Error(y);
            const casted = x as number;
            arr; msg; ternary; neg; composed; prop; indexed; called; instance; casted;
            return x;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    const pass = createCompilerLoweringPassObjectBindingPattern();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns in for-of iteration variables', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-of-pattern.ts',
        `
          export function visit(items: Array<{ x: number; y: string }>): number {
            let total = 0;
            for (const { x, y } of items) { total += x; y; }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    const fn = getFunction(output);
    const loop = fn.body.find((statement) => statement.kind === 'forOf');
    if (loop?.kind !== 'forOf') throw new Error('Expected for-of');

    expect(loop.variable).toMatchObject({ binding: { name: 'objectPatternValue' } });
    expect(loop.body.kind).toBe('block');
    if (loop.body.kind === 'block') {
      const varStatement = loop.body.statements[0];
      expect(varStatement?.kind).toBe('variable');
      if (varStatement?.kind === 'variable') {
        expect(varStatement.declarations.some((d) => 'binding' in d && d.binding.name === 'x')).toBe(true);
        expect(varStatement.declarations.some((d) => 'binding' in d && d.binding.name === 'y')).toBe(true);
      }
    }
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns in class constructors, methods, field closures, and parameter defaults', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-pattern.ts',
        `
          export class Handler {
            field = (source: { x: number }): number => {
              const { x } = source;
              return x;
            };
            constructor(input: { label: string }) {
              const { label } = input;
              label;
            }
            process(source: { value: number }, limit = 10): number {
              const { value } = source;
              return value + limit;
            }
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    const pass = createCompilerLoweringPassObjectBindingPattern();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns in default exports and module-level variable declarations', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'default-export-pattern.ts',
        `
          export const { x, y }: { x: number; y: string } = { x: 1, y: 'hello' };
          export default (source: { z: number }): number => {
            const { z } = source;
            return z;
          };
          function helper(): number { return 1; }
          export { helper };
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );

    expect(output.declarations.some((d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'x')).toBe(
      true,
    );
    expect(output.exports.some((e) => e.kind === 'default')).toBe(true);
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('preserves types through non-optional properties and removes undefined for defaulted optionals', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'type-preservation.ts',
        `
          interface Config {
            required: number;
            optional?: string;
            optionalUndef?: number | undefined;
          }
          export function read(source: Config): string {
            const { required, optional = 'fallback', optionalUndef = 0 }: Config = source;
            return String(required) + optional + optionalUndef;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    const fn = getFunction(output);
    const statement = getVariableStatement(fn.body[0]);

    expect(statement.declarations).toMatchObject([
      { binding: { name: 'objectPatternValue' } },
      { binding: { name: 'required' }, initializer: { kind: 'property', name: 'required' } },
      {
        binding: { name: 'optional' },
        initializer: { fallback: { kind: 'literal', value: 'fallback' }, kind: 'undefinedDefault' },
      },
      {
        binding: { name: 'optionalUndef' },
        initializer: { fallback: { kind: 'literal', value: 0 }, kind: 'undefinedDefault' },
      },
    ]);
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns inside for-loop variable initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-init-pattern.ts',
        `
          export function iterate(items: Array<{ x: number }>): number {
            let total = 0;
            for (const { x } = items[0]!, i = 0; i < 1; ) { total += x; break; }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
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

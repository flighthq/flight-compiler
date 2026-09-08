import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  IrExpression,
  IrFunctionDeclaration,
  IrModule,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
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

  it('covers IR-only expression types via injection in function body', () => {
    const module = lower(
      'inject-ir.ts',
      `export function process(source: { x: number }): number {
         const { x } = source;
         return x;
       }`,
    );
    const clone: IrModule = structuredClone(module);
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
          namedVar('e', { fallback: ident, kind: 'undefinedDefault', value: ident } as IrExpression),
          namedVar('f', {
            excluded: [
              { kind: 'named', name: 'x' },
              { kind: 'computed', expression: ident },
            ],
            kind: 'objectRest',
            object: ident,
          } as IrExpression),
        ],
        kind: 'variable' as const,
      },
      {
        expression: {
          elements: [ident, undefined, ident],
          kind: 'array',
        } as IrExpression,
        kind: 'expression' as const,
      },
      ...declaration.body,
    ];

    const pass = createCompilerLoweringPassObjectBindingPattern();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers nested object patterns with non-function scope and object rest without explicit type', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'nested-rest.ts',
        `
          interface Deep { a: number; b: string }
          export function read(source: { nested: Deep }): number {
            const { nested: { a, ...rest } } = source;
            return a + (rest.b ? 1 : 0);
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns inside for-in iteration variables', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-in-pattern.ts',
        `
          export function visit(items: Record<string, { x: number }>): number {
            let total = 0;
            for (const key in items) { const { x } = items[key]!; total += x; }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('resolves property types on non-optional properties and removes undefined from defaulted unions', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'type-resolution.ts',
        `
          interface Config {
            required: number;
            optionalUnion?: string | number | undefined;
          }
          export function read(source: Config): string {
            const { required, optionalUnion = 'fallback' }: Config = source;
            return String(required) + optionalUnion;
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
        binding: { name: 'optionalUnion' },
        initializer: { fallback: { value: 'fallback' }, kind: 'undefinedDefault' },
      },
    ]);
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns in overloaded functions and default exports', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'overload-default.ts',
        `
          export function process(source: { x: number }): number;
          export function process(source: { x: string }): string;
          export function process(source: { x: number | string }): number | string {
            const { x } = source;
            return x;
          }
          export default (source: { y: number }): number => {
            const { y } = source;
            return y;
          };
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns in class constructors with parameter properties and empty fields', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-constructor-fields.ts',
        `
          export class Container {
            label!: string;
            value = (() => { const { x }: { x: number } = { x: 1 }; return x; })();
            constructor(source: { name: string }, public id: number) {
              const { name } = source;
              this.label = name;
            }
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns through diverse for-loop and control-flow branches', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'control-flow-variety.ts',
        `
          export function branches(
            source: { x: number },
            items: Array<{ a: number }>,
            obj: Record<string, number>,
          ): void {
            const { x } = source;
            if (x > 0) { x; }
            for (;;) { break; }
            for (const item of items) { item.a; }
            for (const key in obj) { key; }
            return;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers object patterns with C-style for expression initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-expression-init.ts',
        `
          export function loop(source: { x: number }): void {
            const { x } = source;
            for (x; x < 10; ) { break; }
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

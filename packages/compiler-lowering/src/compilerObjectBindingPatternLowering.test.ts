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

  it('walks class without constructor, parameter properties, uninitialised fields, overloads, and type declarations', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'declaration-variety.ts',
        `
          export class Minimal {
            label!: string;
            method(): number { const { x }: { x: number } = { x: 1 }; return x; }
          }
          export class Parameterised {
            constructor(public readonly value: number) {
              const { x }: { x: number } = { x: value };
              x;
            }
          }
          export function load(a: { n: number }): number;
          export function load(a: { s: string }): string;
          export function load(a: { n: number } | { s: string }): number | string {
            var { length }: { length: number } = { length: 0 };
            return length;
          }
          export enum Color { Red, Green }
          export interface Shape { area: number }
          export type Label = string;
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('walks if without else, bare return, for-loop edge cases, array holes, and await', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'statement-edges.ts',
        `
          export async function process(source: { x: number }, flag: boolean): Promise<number> {
            const { x } = source;
            if (flag) { x; }
            let i = x;
            for (; i < 10; i++) { i; }
            for (let j = 0; ; ) { break; }
            for (i = 0; i < 1; i++) { i; }
            const arr = [, x, , x];
            arr;
            const result = await Promise.resolve(x);
            result;
            return;
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers non-optional defaults and multi-member optional unions through type removal', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'type-edges.ts',
        `
          export function read(source: { x: number; multi?: number | string }): number {
            const { x = 0, multi = 0 }: { x: number; multi?: number | string } = source;
            return x + Number(multi);
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern()],
    );
    expect(createCompilerLoweringPassObjectBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers tuple, tupleSpread, and tupleRest in the expression walk via IR injection', () => {
    const module = lower(
      'inject-expressions.ts',
      `
        export function read(source: { x: number }, y: number): number {
          const { x } = source;
          return x + y;
        }
      `,
    );
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const ref = { binding: declaration.parameters[1]!.binding };
    const ident: IrExpression = { kind: 'identifier', reference: ref };
    const namedVar = (name: string, initializer: IrExpression): IrVariable =>
      ({
        binding: { id: name, name },
        initializer,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
      }) as IrVariable;

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
        ],
        kind: 'variable' as const,
      },
      ...declaration.body,
    ];

    const pass = createCompilerLoweringPassObjectBindingPattern();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('covers for-in with object pattern and non-block body via IR injection', () => {
    const module = lower(
      'inject-for-in.ts',
      `
        export function scan(source: { x: number }): number {
          const { x } = source;
          return x;
        }
      `,
    );
    const clone = structuredClone(module);
    const declaration = clone.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const ref = { binding: declaration.parameters[0]!.binding };
    const ident: IrExpression = { kind: 'identifier', reference: ref };
    const origin = {
      column: 1,
      fingerprint: 'a'.repeat(64),
      line: 1,
      packageName: '@flighthq/lowering',
      source: 'inject-for-in.ts',
    };

    declaration.body = [
      {
        body: { expression: ident, kind: 'expression' },
        kind: 'forIn',
        object: ident,
        variable: {
          mutable: false,
          pattern: {
            ...origin,
            kind: 'object',
            properties: [
              {
                key: { kind: 'named', name: 'length' },
                pattern: {
                  binding: {
                    ...origin,
                    id: 'length',
                    kind: 'variable',
                    name: 'length',
                    scope: 'block',
                    space: 'value',
                  },
                  kind: 'binding',
                },
              },
            ],
            scope: 'block',
          },
        },
      } as unknown as IrStatement,
      ...declaration.body,
    ];

    const pass = createCompilerLoweringPassObjectBindingPattern();
    const output = pass.lowerIrModule(clone);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it.each([
    ['named', { kind: 'named', reference: { kind: 'ambient', name: 'T' }, typeArguments: [] }],
    [
      'indexedAccess',
      { kind: 'indexedAccess', index: { kind: 'literal', value: 'x' }, object: { kind: 'unknown', source: 'unknown' } },
    ],
    [
      'intersection',
      {
        kind: 'intersection',
        types: [
          { kind: 'primitive', name: 'number' },
          { kind: 'primitive', name: 'string' },
        ],
      },
    ],
    ['keyof', { kind: 'keyof', type: { kind: 'unknown', source: 'unknown' } }],
    ['typeOf', { kind: 'typeOf', reference: { kind: 'ambient', name: 'x' } }],
    ['unknown', { kind: 'unknown', source: 'unknown' }],
    [
      'union containing named',
      {
        kind: 'union',
        types: [
          { kind: 'primitive', name: 'number' },
          { kind: 'named', reference: { kind: 'ambient', name: 'T' }, typeArguments: [] },
        ],
      },
    ],
  ] as const)('refuses defaults with unresolved %s property type', (_label, injectedType) => {
    const module = lower(
      'inject-type.ts',
      `
        export function read(source: { x: number }): number {
          const { x = 0 }: { x: number } = source;
          return x;
        }
      `,
    );
    const clone = structuredClone(module);
    const fn = getFunction(clone);
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const pv = varStmt.declarations[0]!;
    if (!('pattern' in pv) || pv.pattern.kind !== 'object') throw new Error('Expected object pattern');
    const sourceType =
      (pv.pattern as { type?: { kind: string; properties: Array<{ type: unknown }> } }).type ??
      (pv as unknown as { type?: { kind: string; properties: Array<{ type: unknown }> } }).type;
    if (!sourceType || sourceType.kind !== 'object') throw new Error('Expected object source type');
    sourceType.properties[0]!.type = injectedType;

    const pass = createCompilerLoweringPassObjectBindingPattern();
    expect(() => pass.lowerIrModule(clone)).toThrow('requires resolved undefined membership');
  });

  it('handles missing initializer, missing rest type, missing types, and missing property via injection', () => {
    const pass = createCompilerLoweringPassObjectBindingPattern();

    const module1 = lower(
      'inject-no-init.ts',
      `
        export function read(source: { x: number }): number {
          const { x }: { x: number } = source;
          return x;
        }
      `,
    );
    const clone1 = structuredClone(module1);
    const fn1 = getFunction(clone1);
    const vs1 = fn1.body[0];
    if (vs1?.kind !== 'variable') throw new Error('Expected variable');
    const pv1 = vs1.declarations[0]!;
    if (!('pattern' in pv1)) throw new Error('Expected pattern');
    delete (pv1 as Record<string, unknown>).initializer;
    expect(() => pass.lowerIrModule(clone1)).toThrow('object binding pattern requires an initializer');

    const module2 = lower(
      'inject-rest.ts',
      `
        export function read(source: { x: number; y: string }): number {
          const { x, ...rest }: { x: number; y: string } = source;
          return x + rest.y.length;
        }
      `,
    );
    const clone2 = structuredClone(module2);
    const fn2 = getFunction(clone2);
    const vs2 = fn2.body[0];
    if (vs2?.kind !== 'variable') throw new Error('Expected variable');
    const pv2 = vs2.declarations[0]!;
    if (!('pattern' in pv2) || pv2.pattern.kind !== 'object') throw new Error('Expected object pattern');
    if (pv2.pattern.rest && 'type' in pv2.pattern.rest) {
      delete (pv2.pattern.rest as Record<string, unknown>).type;
    }
    const output2 = pass.lowerIrModule(clone2);
    expect(pass.verifyIrModule(output2)).toEqual({ kind: 'valid' });

    const clone3 = structuredClone(module1);
    const fn3 = getFunction(clone3);
    const vs3 = fn3.body[0];
    if (vs3?.kind !== 'variable') throw new Error('Expected variable');
    const pv3 = vs3.declarations[0]!;
    if (!('pattern' in pv3) || pv3.pattern.kind !== 'object') throw new Error('Expected pattern');
    delete (pv3.pattern as Record<string, unknown>).type;
    delete (pv3 as Record<string, unknown>).type;
    const output3 = pass.lowerIrModule(clone3);
    expect(pass.verifyIrModule(output3)).toEqual({ kind: 'valid' });

    const clone4 = structuredClone(module1);
    const fn4 = getFunction(clone4);
    const vs4 = fn4.body[0];
    if (vs4?.kind !== 'variable') throw new Error('Expected variable');
    const pv4 = vs4.declarations[0]!;
    if (!('pattern' in pv4) || pv4.pattern.kind !== 'object') throw new Error('Expected pattern');
    (pv4.pattern.properties[0]!.key as { name: string }).name = 'nonexistent';
    const output4 = pass.lowerIrModule(clone4);
    expect(pass.verifyIrModule(output4)).toEqual({ kind: 'valid' });

    const moduleDefault = lower(
      'inject-allundefined.ts',
      `
        export function read(source: { x?: number }): number {
          const { x = 0 }: { x?: number } = source;
          return x;
        }
      `,
    );
    const clone5 = structuredClone(moduleDefault);
    const fn5 = getFunction(clone5);
    const vs5 = fn5.body[0];
    if (vs5?.kind !== 'variable') throw new Error('Expected variable');
    const pv5 = vs5.declarations[0]!;
    if (!('pattern' in pv5) || pv5.pattern.kind !== 'object') throw new Error('Expected pattern');
    const st5 =
      (pv5.pattern as { type?: { properties: Array<{ type: unknown; optional: boolean }> } }).type ??
      (pv5 as unknown as { type?: { properties: Array<{ type: unknown; optional: boolean }> } }).type;
    if (st5) {
      st5.properties[0]!.type = { kind: 'union', types: [{ kind: 'undefined' }, { kind: 'undefined' }] };
    }
    const output5 = pass.lowerIrModule(clone5);
    expect(pass.verifyIrModule(output5)).toEqual({ kind: 'valid' });

    const moduleNested = lower(
      'inject-nested.ts',
      `
        export function read(source: { inner: { x: number }; items: [number] }): number {
          const { inner: { x }, items: [first] }: { inner: { x: number }; items: [number] } = source;
          return x + first;
        }
      `,
    );
    const clone6 = structuredClone(moduleNested);
    const fn6 = getFunction(clone6);
    const vs6 = fn6.body[0];
    if (vs6?.kind !== 'variable') throw new Error('Expected variable');
    const pv6 = vs6.declarations[0]!;
    if (!('pattern' in pv6) || pv6.pattern.kind !== 'object') throw new Error('Expected pattern');
    const st6 = (pv6.pattern as { type?: { properties: Array<{ name: string }> } }).type;
    if (st6) {
      st6.properties = st6.properties.filter((p) => p.name !== 'inner' && p.name !== 'items');
    }
    for (const prop of pv6.pattern.properties) {
      if ('type' in prop.pattern) delete (prop.pattern as Record<string, unknown>).type;
    }
    const output6 = pass.lowerIrModule(clone6);
    expect(pass.verifyIrModule(output6)).toEqual({ kind: 'valid' });

    const clone7 = structuredClone(moduleNested);
    const fn7 = getFunction(clone7);
    const vs7 = fn7.body[0];
    if (vs7?.kind !== 'variable') throw new Error('Expected variable');
    const pv7 = vs7.declarations[0]!;
    if (!('pattern' in pv7) || pv7.pattern.kind !== 'object') throw new Error('Expected pattern');
    const innerProp = pv7.pattern.properties.find(
      (p) => p.key.kind === 'named' && p.key.name === 'inner' && p.pattern.kind === 'object',
    );
    if (innerProp && innerProp.pattern.kind === 'object') {
      (innerProp.pattern as Record<string, unknown>).type = {
        kind: 'object',
        properties: [{ name: 'x', optional: false, type: { kind: 'primitive', name: 'number' } }],
      };
    }
    const output7 = pass.lowerIrModule(clone7);
    expect(pass.verifyIrModule(output7)).toEqual({ kind: 'valid' });

    const clone8 = structuredClone(module2);
    const fn8 = getFunction(clone8);
    const vs8 = fn8.body[0];
    if (vs8?.kind !== 'variable') throw new Error('Expected variable');
    const pv8 = vs8.declarations[0]!;
    if (!('pattern' in pv8) || pv8.pattern.kind !== 'object') throw new Error('Expected pattern');
    if (pv8.pattern.rest) {
      (pv8.pattern as Record<string, unknown>).rest = {
        elements: [],
        kind: 'array',
        scope: 'block',
        ...(pv8.pattern.rest as Record<string, unknown>),
      };
      (pv8.pattern.rest as Record<string, unknown>).kind = 'array';
    }
    expect(() => pass.lowerIrModule(clone8)).toThrow('object binding rest must introduce one binding');
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

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerLoweringFailure,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrFunctionDeclaration,
  IrModule,
  IrNamedVariable,
  IrStatement,
  IrType,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassArrayBindingPattern } from './compilerArrayBindingPatternLowering.js';
import { createCompilerLoweringPassCStyleFor } from './compilerCStyleForLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';
import { createCompilerLoweringPassObjectBindingPattern } from './compilerObjectBindingPatternLowering.js';

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

  it('lowers array patterns in diverse statement containers and expression kinds', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'statement-variety.ts',
        `
          export function diverse(
            source: [number, string],
            items: Array<{ a: number }>,
            obj: Record<string, number>,
            flag: boolean,
            fn: (n: number) => number,
          ): number {
            const [x, y] = source;
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
            const prop = source[0];
            const indexed = items[x];
            const called = fn(x);
            const instance = new Error(y);
            const casted = x as number;
            const assigned = (flag as unknown as number) + x;
            arr; msg; ternary; neg; composed; prop; indexed; called; instance; casted; assigned;
            return x;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns in class constructors, methods, field closures, and default exports', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'class-pattern.ts',
        `
          export class Handler {
            field = (source: [number]): number => {
              const [x] = source;
              return x;
            };
            constructor(input: [string]) {
              const [label] = input;
              label;
            }
            process(source: [number], limit = 10): number {
              const [value] = source;
              return value + limit;
            }
          }
          export default (source: [number]): number => {
            const [z] = source;
            return z;
          };
          function helper(): number { return 1; }
          export { helper };
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns in for-loop variable initializers and for-in/for-of without patterns', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'for-variety.ts',
        `
          export function iterate(items: Array<[number]>, obj: Record<string, number>): number {
            let total = 0;
            for (const [x]: [number] = items[0]!, i = 0; i < 1; ) { total += x; break; }
            for (const item of items) { total += item[0]; }
            for (const key in obj) { total += obj[key]!; }
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('composes with object-binding-pattern lowering through IR-only expression kinds', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'compose-object.ts',
        `
          interface Cfg { x?: number; nested: { y: string } }
          export function compose(source: [Cfg], key: string): number {
            const [cfg]: [Cfg] = source;
            const { x = 1, nested: { y }, [key]: computed, ...rest }: Cfg = cfg;
            return x + Number(y) + Number(computed) + Number(rest);
          }
        `,
      ),
      [createCompilerLoweringPassObjectBindingPattern(), createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('passes enum, interface, and type alias declarations unchanged', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'passthrough.ts',
        `
          export enum Color { Red, Green, Blue }
          export interface Shape { area(): number; }
          export type Pair = [number, string];
          export function read(source: Pair): number {
            const [first]: Pair = source;
            return first;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(output.declarations.some((d) => d.kind === 'enum')).toBe(true);
    expect(output.declarations.some((d) => d.kind === 'interface')).toBe(true);
    expect(output.declarations.some((d) => d.kind === 'typeAlias')).toBe(true);
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('handles class parameter properties and fields without initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'param-property.ts',
        `
          export class Container {
            label!: string;
            constructor(public readonly values: [number]) {
              const [first]: [number] = values;
              first;
            }
            process(source: [number]): number {
              const [value] = source;
              return value;
            }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns through return expressions, void returns, if without else, and switch', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'return-variety.ts',
        `
          export function returnsVoid(source: [number]): void {
            const [x] = source;
            if (x > 0) { return; }
            x;
          }
          export function returnsSwitch(source: [number]): number {
            const [x] = source;
            switch (x) { case 0: return x; default: return -x; }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('preserves object binding patterns within array pattern rest variables', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'rest-object.ts',
        `
          export function split(values: [number, { key: string }, boolean]): { key: string } {
            const [, ...tail]: [number, { key: string }, boolean] = values;
            return tail[0];
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'split').body[0]).declarations.map(
      getNamedVariable,
    );

    const tail = declarations.find((d) => d.binding.name === 'tail');
    expect(tail).toMatchObject({
      binding: { name: 'tail' },
      initializer: { kind: 'tupleSuffix', start: 1, width: 2 },
    });
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns in classes without an explicit constructor', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'no-constructor.ts',
        `
          export class Processor {
            field = (source: [number]): number => {
              const [x] = source;
              return x;
            };
            process(source: [number, string]): number {
              const [value] = source;
              return value;
            }
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('walks overloaded function parameters when lowering array patterns', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'overloads.ts',
        `
          export function read(values: [number], fallback?: number): number;
          export function read(values: [number, string], fallback?: number): number;
          export function read(values: [number] | [number, string], fallback = 0): number {
            const [first]: [number] = [values[0]];
            return first + fallback;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns alongside await expressions and for-loop expression initializers', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'async-for-expr.ts',
        `
          export async function read(values: [number], p: Promise<number>): Promise<number> {
            const [x] = values;
            const result = await p;
            let total = 0;
            for (total = x; total < result; total++) {}
            return total;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns alongside sparse array literals', () => {
    const module = lower(
      'sparse.ts',
      `
        export function read(values: [number]): (number | undefined)[] {
          const [x] = values;
          return [undefined, x, undefined];
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const exprModule = structuredClone(module);
    const fn = exprModule.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const ident: IrExpression = {
      kind: 'identifier',
      reference: { binding: fn.parameters[0]!.binding, kind: 'binding' },
    };
    (fn.body as IrStatement[]).push({
      expression: { elements: [undefined, ident, undefined], kind: 'array' } as IrExpression,
      kind: 'expression',
    });
    const output = lowerIrModuleWithCompilerPasses(exprModule, [pass]);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('exercises IR-only expression walks through injected tupleSpread, tupleSuffix, tupleRest, and undefinedDefault', () => {
    const module = lower(
      'ir-walk.ts',
      `
        export function read(values: [number, string]): number {
          const [a, b] = values;
          a; b;
          return 0;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const ident: IrExpression = {
      kind: 'identifier',
      reference: { binding: fn.parameters[0]!.binding, kind: 'binding' },
    };
    const expr = (expression: IrExpression): IrStatement => ({ expression, kind: 'expression' as const });
    (fn.body as IrStatement[]).push(
      expr({ kind: 'tupleRest', object: ident, start: 1 } as IrExpression),
      expr({ kind: 'tupleSuffix', object: ident, start: 1, width: 1 } as IrExpression),
      expr({
        fallback: { kind: 'literal', value: 0 } as IrExpression,
        kind: 'undefinedDefault',
        value: ident,
      } as IrExpression),
      expr({
        expression: ident,
        kind: 'await',
        semantics: {
          continuation: 'enqueue-after-settlement',
          fulfillment: 'resume-normal-with-value',
          operandEvaluation: 'once-before-suspension',
          rejection: 'resume-throw-with-reason',
          schema: 'flight-compiler-await-semantics/1',
          suspension: 'always-before-continuation',
          taskResolution: 'normalize-value-task-or-thenable',
        },
      } as IrExpression),
      expr({
        kind: 'tupleSpread',
        segments: [
          {
            expression: ident,
            kind: 'spread',
            type: {
              elements: [
                { optional: false, rest: false, type: { kind: 'primitive' as const, name: 'number' as const } },
              ],
              kind: 'tuple' as const,
              readonly: false as const,
            },
          },
          {
            element: { expression: ident, optional: false },
            kind: 'element',
          },
          {
            element: { optional: true },
            kind: 'element',
          },
        ],
      } as unknown as IrExpression),
    );
    const output = pass.lowerIrModule(injected);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('exercises type resolution helpers with injected unresolved types', () => {
    const module = lower(
      'type-inject.ts',
      `
        export function read(values: [number, string | undefined]): number {
          const [a, b = 'fallback'] = values;
          a; b;
          return 0;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const typeOfType: IrType = {
      kind: 'typeOf',
      reference: { binding: { id: 'test', kind: 'variable', name: 'test' } as IrBindingIdentity, kind: 'binding' },
    } as IrType;
    const unknownType: IrType = { kind: 'unknown', source: 'unknown' } as IrType;
    const unionOfUnresolved: IrType = { kind: 'union', types: [typeOfType, unknownType] } as IrType;
    const multiRetained: IrType = {
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'number' } as IrType,
        { kind: 'primitive', name: 'string' } as IrType,
        { kind: 'undefined' } as IrType,
      ],
    } as IrType;
    const allUndefined: IrType = {
      kind: 'union',
      types: [{ kind: 'undefined' } as IrType, { kind: 'undefined' } as IrType],
    } as IrType;

    const testTypeOf = structuredClone(module);
    const fnTypeOf = testTypeOf.declarations[0];
    if (fnTypeOf?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fnTypeOf.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVar.pattern as { type: IrType }).type = {
      kind: 'tuple',
      elements: [
        { optional: false, rest: false, type: typeOfType },
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } as IrType },
      ],
      readonly: false,
    } as IrType;
    const outputTypeOf = pass.lowerIrModule(testTypeOf);
    expect(pass.verifyIrModule(outputTypeOf)).toEqual({ kind: 'valid' });

    const testMulti = structuredClone(module);
    const fnMulti = testMulti.declarations[0];
    if (fnMulti?.kind !== 'function') throw new Error('Expected function');
    const varStmtMulti = fnMulti.body[0];
    if (varStmtMulti?.kind !== 'variable') throw new Error('Expected variable');
    const patternVarMulti = varStmtMulti.declarations[0];
    if (!patternVarMulti || !('pattern' in patternVarMulti) || patternVarMulti.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVarMulti.pattern as { type: IrType }).type = {
      kind: 'tuple',
      elements: [
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } as IrType },
        { optional: true, rest: false, type: multiRetained },
      ],
      readonly: false,
    } as IrType;
    const outputMulti = pass.lowerIrModule(testMulti);
    const declarations = getFunctionDeclaration(outputMulti, 'read').body[0];
    if (declarations?.kind !== 'variable') throw new Error('Expected variable');
    const bVar = declarations.declarations.find(
      (v): v is IrNamedVariable => !('pattern' in v) && v.binding.name === 'b',
    );
    expect(bVar?.type).toEqual({
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
      ],
    });

    const testUnion = structuredClone(module);
    const fnUnion = testUnion.declarations[0] as IrFunctionDeclaration;
    const varStmtUnion = fnUnion.body[0];
    if (varStmtUnion?.kind !== 'variable') throw new Error('Expected variable');
    const patternVarUnion = varStmtUnion.declarations[0];
    if (!patternVarUnion || !('pattern' in patternVarUnion) || patternVarUnion.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVarUnion.pattern as { type: IrType }).type = {
      kind: 'tuple',
      elements: [
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } as IrType },
        { optional: false, rest: false, type: unionOfUnresolved },
      ],
      readonly: false,
    } as IrType;
    (patternVarUnion.pattern.elements[1] as unknown as { initializer: IrExpression }).initializer = {
      kind: 'literal',
      value: 'x',
    } as IrExpression;
    expect(() => pass.lowerIrModule(testUnion)).toThrow('requires resolved undefined membership');

    const testNever = structuredClone(module);
    const fnNever = testNever.declarations[0] as IrFunctionDeclaration;
    const varStmtNever = fnNever.body[0];
    if (varStmtNever?.kind !== 'variable') throw new Error('Expected variable');
    const patternVarNever = varStmtNever.declarations[0];
    if (!patternVarNever || !('pattern' in patternVarNever) || patternVarNever.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVarNever.pattern as { type: IrType }).type = {
      kind: 'tuple',
      elements: [
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } as IrType },
        { optional: true, rest: false, type: allUndefined },
      ],
      readonly: false,
    } as IrType;
    const outputNever = pass.lowerIrModule(testNever);
    const neverDecl = getFunctionDeclaration(outputNever, 'read').body[0];
    if (neverDecl?.kind !== 'variable') throw new Error('Expected variable');
    const bNever = neverDecl.declarations.find(
      (v): v is IrNamedVariable => !('pattern' in v) && v.binding.name === 'b',
    );
    expect(bNever?.type).toEqual({ kind: 'never' });
  });

  it('lowers rest elements that bind to object patterns', () => {
    const module = lower(
      'rest-object-pattern.ts',
      `
        export function read(values: [number, string, boolean]): boolean {
          const [first, ...rest]: [number, string, boolean] = values;
          first; rest;
          return true;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVar.pattern as { rest: unknown }).rest = {
      kind: 'object',
      properties: [],
      scope: 'block',
    };
    const output = pass.lowerIrModule(injected);
    const body = getFunctionDeclaration(output, 'read').body;
    const declarations = getVariableStatement(body[0]).declarations;
    const restVar = declarations.find((v) => 'pattern' in v && v.pattern.kind === 'object');
    expect(restVar).toBeDefined();
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers pattern binding elements with explicit type annotations', () => {
    const module = lower(
      'pattern-type.ts',
      `
        export function read(values: [number]): number {
          const [x] = values;
          return x;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    const firstElement = patternVar.pattern.elements[0];
    if (!firstElement || firstElement.pattern.kind !== 'binding') throw new Error('Expected binding');
    (firstElement.pattern as { type: IrType }).type = { kind: 'primitive', name: 'string' } as IrType;
    const output = pass.lowerIrModule(injected);
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'read').body[0]).declarations;
    const xVar = declarations.find((v): v is IrNamedVariable => !('pattern' in v) && v.binding.name === 'x');
    expect(xVar?.type).toEqual({ kind: 'primitive', name: 'string' });
  });

  it('lowers rest elements with explicit type annotations', () => {
    const module = lower(
      'rest-type.ts',
      `
        export function split(values: [number, ...string[]]): string[] {
          const [first, ...rest]: [number, ...string[]] = values;
          first;
          return rest;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    if (!patternVar.pattern.rest || patternVar.pattern.rest.kind !== 'binding') {
      throw new Error('Expected binding rest');
    }
    (patternVar.pattern.rest as { type: IrType }).type = {
      element: { kind: 'primitive', name: 'boolean' },
      kind: 'array',
    } as IrType;
    const output = pass.lowerIrModule(injected);
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'split').body[0]).declarations.map(
      getNamedVariable,
    );
    const restVar = declarations.find((v) => v.binding.name === 'rest');
    expect(restVar?.type).toEqual({ element: { kind: 'primitive', name: 'boolean' }, kind: 'array' });
  });

  it('handles non-array pattern variables and variables without types through injection', () => {
    const module = lower(
      'variable-paths.ts',
      `
        export function read(values: [number]): number {
          const [x] = values;
          return x;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const objectPatternVar: IrVariable = {
      mutable: false,
      pattern: { kind: 'object', properties: [], scope: 'block' },
      type: { kind: 'primitive', name: 'number' } as IrType,
    } as unknown as IrVariable;
    (varStmt as unknown as { declarations: IrVariable[] }).declarations.push(objectPatternVar);
    const output = pass.lowerIrModule(injected);
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('lowers array patterns containing object sub-pattern elements', () => {
    const output = lowerIrModuleWithCompilerPasses(
      lower(
        'object-element.ts',
        `
          export function read(values: [{ a: number }, string]): number {
            const [{ a }, label]: [{ a: number }, string] = values;
            label;
            return a;
          }
        `,
      ),
      [createCompilerLoweringPassArrayBindingPattern()],
    );
    const body = getFunctionDeclaration(output, 'read').body;
    const declarations = getVariableStatement(body[0]).declarations;
    const objectVar = declarations.find((v) => 'pattern' in v && v.pattern.kind === 'object');
    expect(objectVar).toBeDefined();
    expect(createCompilerLoweringPassArrayBindingPattern().verifyIrModule(output)).toEqual({ kind: 'valid' });
  });

  it('produces never type when removing undefined from an all-undefined union', () => {
    const module = lower(
      'all-undefined.ts',
      `
        export function read(values: [number | undefined]): number {
          const [x = 0] = values;
          return x;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    (patternVar.pattern as { type: IrType }).type = {
      elements: [
        {
          optional: true,
          rest: false,
          type: { kind: 'union', types: [{ kind: 'undefined' }, { kind: 'undefined' }] } as IrType,
        },
      ],
      kind: 'tuple',
      readonly: false,
    } as IrType;
    const output = pass.lowerIrModule(injected);
    const declarations = getVariableStatement(getFunctionDeclaration(output, 'read').body[0]).declarations;
    const xVar = declarations.find((v): v is IrNamedVariable => !('pattern' in v) && v.binding.name === 'x');
    expect(xVar?.type).toEqual({ kind: 'never' });
  });

  it('refuses array pattern variables without any type information', () => {
    const module = lower(
      'no-type.ts',
      `
        export function read(values: [number]): number {
          const [x] = values;
          return x;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const injected = structuredClone(module);
    const fn = injected.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const varStmt = fn.body[0];
    if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
    const patternVar = varStmt.declarations[0];
    if (!patternVar || !('pattern' in patternVar) || patternVar.pattern.kind !== 'array') {
      throw new Error('Expected array pattern');
    }
    delete (patternVar.pattern as unknown as Record<string, unknown>).type;
    delete (patternVar as unknown as Record<string, unknown>).type;
    const run = () => pass.lowerIrModule(injected);
    expectLoweringFailure(run, 'array binding lowering requires a statically known tuple type');
  });

  it('prepends empty lowered variables as a no-op for empty iteration patterns', () => {
    const module = lower(
      'empty-iter.ts',
      `
        export function read(values: [number], items: [number][]): number {
          const [x] = values;
          for (const [] of items) {}
          return x;
        }
      `,
    );
    const pass = createCompilerLoweringPassArrayBindingPattern();
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);
    const body = getFunctionDeclaration(output, 'read').body;
    const forOf = body.find((s): s is Extract<IrStatement, { kind: 'forOf' }> => s.kind === 'forOf');
    expect(forOf).toBeDefined();
    expect(forOf?.body.kind).toBe('block');
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
    {
      reason: 'only array binding patterns can be normalized by this pass',
      source:
        'export function read(items: Array<{a: number}>, values: [number]): void { const [x]: [number] = values; for (const {a} of items) { a; x; } }',
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

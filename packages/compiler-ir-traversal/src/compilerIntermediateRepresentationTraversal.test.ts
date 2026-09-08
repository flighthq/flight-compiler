import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrExpression, IrModule, IrStatement, IrType } from '../../compiler-types/src/index.js';
import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
} from './compilerIntermediateRepresentationTraversal.js';

describe('analyzeIrModuleTraversal', () => {
  it('visits the type carried by union member test evidence', () => {
    const module = lower(
      `interface Circle { kind: 'circle'; radius: number; }
       interface Square { kind: 'square'; side: number; }
       export function isCircle(shape: Circle | Square): boolean { return shape.kind === 'circle'; }`,
    );
    const paths: string[] = [];

    analyzeIrModuleTraversal(module, {
      type(type, path) {
        if (type.kind === 'named') paths.push(path.join('.'));
      },
    });

    expect(paths).toContain('declarations.2.body.0.expression.semantics.unionMemberTest.member');
  });

  it('observes every public node family in deterministic preorder without mutating the module', () => {
    const module = lower(`
      import { external as imported } from './imported.js';
      export { imported };
      export type ExternalMap<T extends PromiseLike<number> = Set<string>> =
        Readonly<Map<string, T & Float32Array>>;
      export type ExternalIndexed = ExternalShape['value'];
      export type ExternalKey = keyof ExternalShape;
      export type ExternalObject = {
        callback: <T extends Error = Error>(value: T) => Promise<T>;
        value: 'literal' | 1 | true | null | undefined | never;
      };
      export type ExternalTuple = [Date, RegExp?];
      export type ExternalQuery = typeof Promise;
      export interface ExternalShape<Value = Uint8Array> extends Iterable<Value> {
        value?: Required<Array<Value>>;
      }
      export enum ExternalChoice { first }
      export class ExternalError extends Error {}
      export class ExternalBox<T extends Error = Error> implements ExternalShape {
        field: Promise<T> = Promise.resolve(new Error());
        constructor(input: ReadonlyArray<Int32Array>);
        constructor(input: ReadonlyArray<Int32Array> = []) { input as unknown as Float64Array; }
        method<U extends WeakMap<object, object>>(value: U): Partial<Record<string, Uint32Array>> {
          const output: Array<Uint16Array> = new Array<Uint16Array>();
          return ({ value, output } as unknown) as Partial<Record<string, Uint32Array>>;
        }
      }
      export function overloaded(value: Date): RegExp;
      export function overloaded(value: Error): Error;
      export function overloaded(value: Date | Error): RegExp | Error { return value as Error; }
      export const externalValue: DataView | undefined = undefined;
      export async function containers(values: number[]): Promise<number> {
        let total: number = [1, , 2][0]!;
        const [first = 0, , ...remaining] = values;
        const propertyName = 'value';
        const { [propertyName]: selected = total, ...other } = { value: total };
        total += first + (remaining[0] ?? 0);
        total += values?.[0] ?? 0;
        { var hoisted: number = total; }
        total += hoisted;
        do { total = total + 1; } while (false);
        while (total < 2) { total++; break; }
        for (let index: number = 0; index < 1; index++) {
          if (index) continue;
          else total += index;
        }
        for (total = 0; total < 1; total++) total;
        for (const value of values) total += value;
        for (const key in { value: total }) key;
        switch (total) { case 0: break; default: total = -total; }
        try {
          await Promise.resolve(total);
        } catch (error) {
          throw error;
        } finally {
          /total/.test(\`\${total}\`);
        }
        const nested = async (value: number = values[0]): Promise<number> =>
          await Promise.resolve(({ ...{ value }, [value]: value } as object)).then(() => value);
        const block = (): number => { return total; };
        return true ? await nested(...values) : block();
      }
      export default ({ value: 1 } as unknown) as Date;
    `);
    const before = structuredClone(module);
    const events: string[] = [];
    const bindingPatterns: string[] = [];
    const declarations: string[] = [];
    const expressions = new Set<string>();
    const statements = new Set<string>();
    const types = new Set<string>();
    let modules = 0;
    let objectMembers = 0;
    let optionalChains = 0;
    let parameters = 0;
    let signatures = 0;
    let typeParameters = 0;
    let variables = 0;

    analyzeIrModuleTraversal(module, {
      bindingPattern(pattern) {
        bindingPatterns.push(pattern.kind);
        events.push(`pattern:${pattern.kind}`);
      },
      declaration(declaration) {
        declarations.push(declaration.kind);
        events.push(`declaration:${declaration.kind}`);
      },
      expression(expression) {
        expressions.add(expression.kind);
        events.push(`expression:${expression.kind}`);
      },
      functionSignature() {
        signatures += 1;
        events.push('functionSignature');
      },
      module() {
        modules += 1;
        events.push('module');
      },
      objectMember() {
        objectMembers += 1;
        events.push('objectMember');
      },
      optionalChain() {
        optionalChains += 1;
        events.push('optionalChain');
      },
      parameter() {
        parameters += 1;
        events.push('parameter');
      },
      statement(statement) {
        statements.add(statement.kind);
        events.push(`statement:${statement.kind}`);
      },
      type(type) {
        types.add(type.kind);
        events.push(`type:${type.kind}`);
      },
      typeParameter() {
        typeParameters += 1;
        events.push('typeParameter');
      },
      variable() {
        variables += 1;
        events.push('variable');
      },
    });

    expect(events.slice(0, 2)).toEqual(['module', 'declaration:typeAlias']);
    expect(modules).toBe(1);
    expect(objectMembers).toBeGreaterThanOrEqual(4);
    expect(optionalChains).toBe(1);
    expect(declarations).toEqual([
      'typeAlias',
      'typeAlias',
      'typeAlias',
      'typeAlias',
      'typeAlias',
      'typeAlias',
      'interface',
      'enum',
      'class',
      'class',
      'function',
      'variable',
      'function',
    ]);
    expect(bindingPatterns).toEqual(expect.arrayContaining(['array', 'binding']));
    expect(parameters).toBe(8);
    expect(signatures).toBeGreaterThanOrEqual(7);
    expect(typeParameters).toBe(5);
    expect(variables).toBeGreaterThanOrEqual(10);
    expect(expressions).toEqual(
      expect.objectContaining(
        new Set([
          'array',
          'assignment',
          'await',
          'binary',
          'call',
          'cast',
          'conditional',
          'element',
          'function',
          'identifier',
          'literal',
          'new',
          'object',
          'property',
          'regexp',
          'spread',
          'template',
          'unary',
        ]),
      ),
    );
    expect(statements).toEqual(
      expect.objectContaining(
        new Set([
          'block',
          'break',
          'continue',
          'do',
          'expression',
          'for',
          'forIn',
          'forOf',
          'if',
          'return',
          'switch',
          'throw',
          'try',
          'variable',
          'while',
        ]),
      ),
    );
    expect(types).toEqual(
      expect.objectContaining(
        new Set([
          'array',
          'function',
          'indexedAccess',
          'intersection',
          'keyof',
          'literal',
          'named',
          'never',
          'null',
          'object',
          'primitive',
          'tuple',
          'typeOf',
          'undefined',
          'union',
          'unknown',
        ]),
      ),
    );
    expect(module).toEqual(before);
    const firstRun = [...events];
    analyzeIrModuleTraversal(module, {
      bindingPattern(pattern) {
        events.push(`pattern:${pattern.kind}`);
      },
      declaration(declaration) {
        events.push(`declaration:${declaration.kind}`);
      },
      expression(expression) {
        events.push(`expression:${expression.kind}`);
      },
      functionSignature() {
        events.push('functionSignature');
      },
      module() {
        events.push('module');
      },
      objectMember() {
        events.push('objectMember');
      },
      optionalChain() {
        events.push('optionalChain');
      },
      parameter() {
        events.push('parameter');
      },
      statement(statement) {
        events.push(`statement:${statement.kind}`);
      },
      type(type) {
        events.push(`type:${type.kind}`);
      },
      typeParameter() {
        events.push('typeParameter');
      },
      variable() {
        events.push('variable');
      },
    });
    expect(events.slice(firstRun.length)).toEqual(firstRun);
  });

  it('accepts an empty observer as the traversal identity', () => {
    const module = lower('export default ({ value: 1 } as unknown) as { value: number };');

    expect(analyzeIrModuleTraversal(module, {})).toBeUndefined();
  });

  it('reports frozen portable paths from the module root for every observer family', () => {
    const module = lower(`
      export function read<Value extends number>(input?: { value: Value }): number {
        const { value = 0 } = input ?? { value: 1 as Value };
        return input?.value ?? value;
      }
    `);
    const paths: Array<readonly [string, readonly (number | string)[]]> = [];
    const addPath = (family: string, path: readonly (number | string)[]) => {
      expect(Object.isFrozen(path)).toBe(true);
      paths.push([family, path]);
    };

    analyzeIrModuleTraversal(module, {
      bindingPattern(_pattern, path) {
        addPath('bindingPattern', path);
      },
      declaration(_declaration, path) {
        addPath('declaration', path);
      },
      expression(_expression, path) {
        addPath('expression', path);
      },
      functionSignature(_signature, path) {
        addPath('functionSignature', path);
      },
      module(_module, path) {
        addPath('module', path);
      },
      objectMember(_member, path) {
        addPath('objectMember', path);
      },
      optionalChain(_semantics, path) {
        addPath('optionalChain', path);
      },
      parameter(_parameter, path) {
        addPath('parameter', path);
      },
      statement(_statement, path) {
        addPath('statement', path);
      },
      type(_type, path) {
        addPath('type', path);
      },
      typeParameter(_parameter, path) {
        addPath('typeParameter', path);
      },
      variable(_variable, path) {
        addPath('variable', path);
      },
    });

    expect(paths).toEqual(
      expect.arrayContaining([
        ['module', []],
        ['declaration', ['declarations', 0]],
        ['functionSignature', ['declarations', 0]],
        ['typeParameter', ['declarations', 0, 'typeParameters', 0]],
        ['parameter', ['declarations', 0, 'parameters', 0]],
        ['type', ['declarations', 0, 'parameters', 0, 'type']],
        ['statement', ['declarations', 0, 'body', 0]],
        ['variable', ['declarations', 0, 'body', 0, 'declarations', 0]],
        ['bindingPattern', ['declarations', 0, 'body', 0, 'declarations', 0, 'pattern']],
        ['objectMember', ['declarations', 0, 'body', 0, 'declarations', 0, 'initializer', 'right', 'members', 0]],
        ['type', ['declarations', 0, 'body', 0, 'declarations', 0, 'initializer', 'right', 'type']],
        ['optionalChain', ['declarations', 0, 'body', 1, 'expression', 'left', 'optionalChain']],
      ]),
    );
  });

  it('visits neutral extra-argument erasure result evidence at its semantic path', () => {
    const module = lower(`
      function choose(value: number): number { return value; }
      export default choose(1, 2);
    `);
    const paths: Array<readonly (number | string)[]> = [];

    analyzeIrModuleTraversal(module, {
      type(_type, path) {
        if (path.includes('extraArguments')) paths.push(path);
      },
    });

    expect(paths).toEqual([['exports', 0, 'expression', 'semantics', 'extraArguments', 'resultType']]);
  });

  it('visits provided default-argument type evidence at canonical semantic paths', () => {
    const module = lower(`
      function choose(value: number | null = 1): number | null { return value; }
      export default choose(null);
    `);
    const paths: Array<readonly (number | string)[]> = [];

    analyzeIrModuleTraversal(module, {
      type(_type, path) {
        if (path.includes('defaultParameters')) paths.push(path);
      },
    });

    expect(paths).toEqual([
      ['exports', 0, 'expression', 'semantics', 'defaultParameters', 'provided', 0, 'argumentType'],
      ['exports', 0, 'expression', 'semantics', 'defaultParameters', 'provided', 0, 'parameterType'],
      ['exports', 0, 'expression', 'semantics', 'defaultParameters', 'provided', 0, 'parameterType', 'types', 0],
      ['exports', 0, 'expression', 'semantics', 'defaultParameters', 'provided', 0, 'parameterType', 'types', 1],
    ]);
  });

  it('visits class method overload signatures at canonical semantic paths', () => {
    const module = lower(`
      export class Picker {
        choose(value: number): number;
        choose(value: number, radix?: number): number;
        choose(value: number, radix = 10): number { return value + radix; }
      }
    `);
    const paths: Array<readonly (number | string)[]> = [];

    analyzeIrModuleTraversal(module, {
      functionSignature(_signature, path) {
        paths.push(path);
      },
    });

    expect(paths).toEqual([
      ['declarations', 0, 'methods', 0],
      ['declarations', 0, 'methods', 0, 'overloads', 0],
      ['declarations', 0, 'methods', 0, 'overloads', 1],
    ]);
  });

  it('visits lowering-only expression carriers and their semantic type evidence', () => {
    const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
    const tupleType = {
      elements: [{ optional: false, rest: false, type: numberType }],
      kind: 'tuple',
      readonly: false,
    } as const satisfies IrType;
    const identifier = { kind: 'identifier', reference: { kind: 'ambient', name: 'value' } } as const;
    const expressions: IrExpression[] = [
      {
        excluded: [
          { kind: 'named', name: 'fixed' },
          { coercion: 'string', expression: { kind: 'literal', value: 'computed' }, kind: 'computed' },
        ],
        kind: 'objectRest',
        object: identifier,
        type: { kind: 'object', properties: [] },
      },
      { elements: [{ expression: { kind: 'literal', value: 1 }, optional: false }, { optional: true }], kind: 'tuple' },
      {
        kind: 'tupleSpread',
        segments: [
          { element: { expression: { kind: 'literal', value: 1 }, optional: false }, kind: 'element' },
          { element: { optional: true }, kind: 'element' },
          { expression: identifier, kind: 'spread', type: tupleType },
        ],
        type: tupleType,
      },
      { kind: 'tupleRest', object: identifier, start: 1 },
      { kind: 'tupleSuffix', object: identifier, start: 0, width: 1 },
      { fallback: { kind: 'literal', value: 0 }, kind: 'undefinedDefault', value: identifier },
      { kind: 'undefinedValue', type: { kind: 'union', types: [numberType, { kind: 'undefined' }] } },
      {
        arguments: [{ kind: 'literal', value: 1 }],
        callee: identifier,
        kind: 'call',
        optional: true,
        semantics: {
          optionalChain: {
            receiverEvaluation: 'once',
            receiverNullish: 'possible',
            receiverType: { kind: 'union', types: [numberType, { kind: 'undefined' }] },
            result: 'undefined',
            shortCircuit: 'nullish',
            valueType: numberType,
          },
          optionalParameters: {
            omitted: [],
            optional: [0],
            parameterCount: 1,
            provided: [{ argumentType: numberType, parameterType: numberType, position: 0, value: 'value' }],
            providedArgumentCount: 1,
          },
        },
        typeArguments: [numberType],
      },
      {
        arguments: [{ kind: 'literal', value: 1 }],
        callee: identifier,
        kind: 'new',
        semantics: {},
        typeArguments: [numberType],
      },
    ];
    const module = {
      ...lower(''),
      exports: [{ expression: { elements: expressions, kind: 'array' }, kind: 'default' }],
    } satisfies IrModule;
    const expressionKinds = new Set<string>();
    const typeKinds = new Set<string>();

    analyzeIrModuleTraversal(module, {
      expression(expression) {
        expressionKinds.add(expression.kind);
      },
      type(type) {
        typeKinds.add(type.kind);
      },
    });

    expect(expressionKinds).toEqual(
      expect.objectContaining(
        new Set([
          'call',
          'new',
          'objectRest',
          'tuple',
          'tupleRest',
          'tupleSpread',
          'tupleSuffix',
          'undefinedDefault',
          'undefinedValue',
        ]),
      ),
    );
    expect(typeKinds).toEqual(expect.objectContaining(new Set(['object', 'primitive', 'tuple', 'undefined', 'union'])));
  });

  it('stops the whole traversal immediately when an observer returns false', () => {
    const module = lower('interface Value { count: number } export const value = 1;');
    const events: string[] = [];

    expect(
      analyzeIrModuleTraversal(module, {
        declaration() {
          events.push('declaration');
        },
        module() {
          events.push('module');
          return false;
        },
      }),
    ).toBeUndefined();
    expect(events).toEqual(['module']);
  });

  it('fails loudly for every unknown runtime discriminated family', () => {
    const base = lower(
      'export interface Shape { value: number } export type Value = number; export function read(): number { return 1; }',
    );
    const typeAlias = base.declarations.find((declaration) => declaration.kind === 'typeAlias');
    const functionDeclaration = base.declarations.find((declaration) => declaration.kind === 'function');
    if (typeAlias?.kind !== 'typeAlias' || functionDeclaration?.kind !== 'function') {
      throw new Error('Expected traversal failure fixtures');
    }
    const subjects = [
      {
        kind: 'future-declaration',
        module: { ...base, declarations: [{ kind: 'future-declaration' }] },
      },
      {
        kind: 'future-expression',
        module: { ...base, exports: [{ expression: { kind: 'future-expression' }, kind: 'default' }] },
      },
      {
        kind: 'future-object-member',
        module: {
          ...base,
          exports: [
            {
              expression: {
                kind: 'object',
                members: [{ kind: 'future-object-member' }],
                type: { kind: 'unknown', source: 'object' },
              },
              kind: 'default',
            },
          ],
        },
      },
      {
        kind: 'future-statement',
        module: {
          ...base,
          declarations: [{ ...functionDeclaration, body: [{ kind: 'future-statement' }] }],
        },
      },
      {
        kind: 'future-type',
        module: { ...base, declarations: [{ ...typeAlias, type: { kind: 'future-type' } }] },
      },
    ] as const;

    for (const subject of subjects) {
      expect(() => analyzeIrModuleTraversal(subject.module as unknown as IrModule, {})).toThrow(
        `Unknown IR traversal kind ${subject.kind}`,
      );
    }
  });
});
describe('analyzeIrExpressionSubtreeTraversal', () => {
  it('walks one expression and stops when an observer returns false', () => {
    const expression: IrExpression = {
      kind: 'binary',
      left: { kind: 'literal', value: 1 },
      operator: '+',
      right: { kind: 'literal', value: 2 },
      semantics: {
        left: { declared: 'number', flow: 'number' },
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      },
    };
    const all: string[] = [];
    const stopped: string[] = [];

    analyzeIrExpressionSubtreeTraversal(expression, {
      expression(candidate) {
        all.push(candidate.kind);
        return undefined;
      },
    });
    analyzeIrExpressionSubtreeTraversal(expression, {
      expression(candidate) {
        stopped.push(candidate.kind);
        return candidate.kind !== 'literal';
      },
    });

    expect(all).toEqual(['binary', 'literal', 'literal']);
    // The stop signal is caught here too, so a subtree walk ends the way a module walk does: the
    // second literal is never reached.
    expect(stopped).toEqual(['binary', 'literal']);
  });

  it('propagates observer errors through the subtree boundary', () => {
    const expression: IrExpression = { kind: 'literal', value: 1 };

    expect(() =>
      analyzeIrExpressionSubtreeTraversal(expression, {
        expression() {
          throw new Error('observer failure');
        },
      }),
    ).toThrow('observer failure');
  });
});

describe('analyzeIrStatementSubtreeTraversal', () => {
  it('walks one statement without the module around it', () => {
    const statement: IrStatement = {
      expression: { kind: 'literal', value: 1 },
      kind: 'return',
    };
    const seen: string[] = [];

    analyzeIrStatementSubtreeTraversal(statement, {
      expression(candidate) {
        seen.push(candidate.kind);
        return undefined;
      },
      statement(candidate) {
        seen.push(candidate.kind);
        return undefined;
      },
    });

    expect(seen).toEqual(['return', 'literal']);
  });

  it('propagates observer errors through the subtree boundary', () => {
    const statement: IrStatement = { expression: { kind: 'literal', value: 1 }, kind: 'return' };

    expect(() =>
      analyzeIrStatementSubtreeTraversal(statement, {
        statement() {
          throw new Error('statement observer failure');
        },
      }),
    ).toThrow('statement observer failure');
  });
});

function lower(source: string) {
  return lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/traversal/src/value.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/traversal', upstreamDirectory: '/flight' },
  ).module;
}

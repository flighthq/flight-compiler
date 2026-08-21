import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerIrModuleValidationFailureCode,
  IrArrayBindingPattern,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { validateIrModuleStructure } from './compilerIrModuleStructure.js';

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/validation/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/validation', upstreamDirectory: '/flight' },
  ).module;
}

describe('validateIrModuleStructure', () => {
  it('accepts empty and container-rich modules deterministically without changing them', () => {
    const empty = lower('empty.ts', '');
    const rich = lower(
      'rich.ts',
      `
        import { external as imported } from './imported.js';
        import type { ExternalType } from './types.js';
        export { imported };
        export type { ExternalType };
        export { external as renamed } from './reexport.js';
        export * from './barrel.js';
        export * as namespace from './namespace.js';
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
        export interface ExternalShape extends Iterable<Uint8Array> {
          value?: Required<Array<Int16Array>>;
        }
        export enum ExternalChoice { first }
        export class ExternalError extends Error {}
        export class ExternalBox<T extends Error = Error> implements ExternalShape {
          field: Promise<T> = Promise.resolve(new Error());
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
        export type ExternalValueType = typeof externalValue;
        export async function containers(values: number[]): Promise<number> {
          let total: number = [1, , 2][0]!;
          const [first = 0, , ...remaining] = values;
          total += first + (remaining[0] ?? 0);
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
          const named = function named(value: number): number { return value ? named(value - 1) : value; };
          named(total);
          return true ? await nested(...values) : block();
        }
        export default ({ value: 1 } as unknown) as Date;
      `,
    );
    const snapshot = structuredClone(rich);

    expect(validateIrModuleStructure(empty)).toEqual({ kind: 'valid' });
    expect(validateIrModuleStructure(rich)).toEqual({ kind: 'valid' });
    expect(validateIrModuleStructure(rich)).toEqual(validateIrModuleStructure(rich));
    expect(rich).toEqual(snapshot);
  });

  it('validates fixed tuple-spread segments, widths, and optional positions', () => {
    const valid = lower(
      'tuple-spread.ts',
      "type Pair = [number, string]; const pair: Pair = [1, 'flight']; export const value: [boolean, number, string] = [true, ...pair];",
    );
    const declaration = valid.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (declaration?.kind !== 'variable' || declaration.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread variable');
    }
    const expression = declaration.initializer;
    const spread = expression.segments.find((segment) => segment.kind === 'spread');
    if (spread?.kind !== 'spread') throw new Error('Expected tuple spread segment');
    const replacements = [
      { ...expression, segments: expression.segments.filter((segment) => segment.kind !== 'spread') },
      {
        ...expression,
        segments: expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? {
                ...segment,
                type: {
                  ...segment.type,
                  elements: [{ optional: false, rest: true, type: { kind: 'primitive', name: 'number' } }],
                },
              }
            : segment,
        ),
      },
      { ...expression, segments: expression.segments.slice(1) },
      {
        ...expression,
        segments: expression.segments.map((segment) =>
          segment.kind === 'spread'
            ? {
                ...segment,
                type: {
                  ...segment.type,
                  elements: segment.type.elements.map((element, index) =>
                    index === 0 ? { ...element, optional: true } : element,
                  ),
                },
              }
            : segment,
        ),
      },
    ];

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    for (const replacement of replacements) {
      const module = structuredClone(valid);
      const item = module.declarations.find(
        (candidate) => candidate.kind === 'variable' && 'binding' in candidate && candidate.binding.name === 'value',
      );
      if (item?.kind !== 'variable') throw new Error('Expected cloned tuple spread variable');
      (item as { initializer?: IrExpression }).initializer = replacement as IrExpression;
      const result = validateIrModuleStructure(module);

      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('validates observable undefined separately from proven-uninitialized function entry', () => {
    const valid = lower('variable-entry.ts', 'export function read(): void { var value: number; }');
    const declaration = valid.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'variable') {
      throw new Error('Expected function-scoped variable');
    }
    const variable = declaration.body[0].declarations[0];
    if (!variable || 'pattern' in variable) throw new Error('Expected named variable');
    (variable as { initialValue?: unknown }).initialValue = 'undefined';

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    (variable as { initialValue?: unknown }).initialValue = 'uninitialized';
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalidValue = structuredClone(valid);
    const invalidFunction = invalidValue.declarations[0];
    if (invalidFunction?.kind !== 'function' || invalidFunction.body[0]?.kind !== 'variable') {
      throw new Error('Expected cloned function-scoped variable');
    }
    const invalidVariable = invalidFunction.body[0].declarations[0];
    if (!invalidVariable || 'pattern' in invalidVariable) throw new Error('Expected cloned named variable');
    (invalidVariable as { initialValue?: unknown }).initialValue = 'missing';

    const moduleVariable = lower('module-entry.ts', 'export const value: number = 1;');
    const moduleDeclaration = moduleVariable.declarations[0];
    if (moduleDeclaration?.kind !== 'variable' || 'pattern' in moduleDeclaration) {
      throw new Error('Expected module variable');
    }
    (moduleDeclaration as { initialValue?: unknown }).initialValue = 'undefined';

    for (const module of [invalidValue, moduleVariable]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('validates static for-in keys against pure object enumeration order', () => {
    const valid = lower(
      'static-for-in.ts',
      "export function first(): string { for (const key in { second: 2, 10: 10, 2: 2 }) return key; return ''; }",
    );

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'forIn') {
      throw new Error('Expected static for-in statement');
    }
    (
      declaration.body[0] as { keyPlan?: { evaluation: 'elide'; keys: readonly string[]; kind: 'objectLiteral' } }
    ).keyPlan = {
      evaluation: 'elide',
      keys: ['second', '2', '10'],
      kind: 'objectLiteral',
    };
    const result = validateIrModuleStructure(invalid);

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures).toContainEqual(
        expect.objectContaining({ code: 'invalid-node-shape', path: expect.stringContaining('.keyPlan.keys') }),
      );
    }
  });

  it('validates optional-chain and property-key coercion evidence together', () => {
    const valid = lower(
      'optional-element.ts',
      'export function first(values?: number[]): number | undefined { return values?.[0]; }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'element') throw new Error('Expected optional element expression');
    (expression.semantics as { key?: unknown; optionalChain?: unknown }).key = 'coerceEventually';
    delete (expression.semantics as { optionalChain?: unknown }).optionalChain;

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.path)).toEqual(
        expect.arrayContaining([expect.stringContaining('.semantics.key'), expect.stringContaining('.optionalChain')]),
      );
    }

    const incoherent = structuredClone(valid);
    const incoherentDeclaration = incoherent.declarations[0];
    const incoherentStatement = incoherentDeclaration?.kind === 'function' ? incoherentDeclaration.body[0] : undefined;
    const incoherentExpression = incoherentStatement?.kind === 'return' ? incoherentStatement.expression : undefined;
    if (incoherentExpression?.kind !== 'element' || !incoherentExpression.semantics.optionalChain) {
      throw new Error('Expected optional element evidence');
    }
    (incoherentExpression.semantics.optionalChain as { receiverNullish: string }).receiverNullish = 'excluded';
    expect(validateIrModuleStructure(incoherent)).toMatchObject({
      failures: [expect.objectContaining({ path: expect.stringContaining('.optionalChain') })],
      kind: 'invalid',
    });
  });

  it('validates exact default-parameter call arity, ordering, and omissions', () => {
    const valid = lower(
      'default-call.ts',
      'function choose(first: number, second = 2, third = 3): number { return first; } export function read(): number { return choose(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const replacements = [
      { defaulted: [2, 1], omitted: [1, 2], parameterCount: 3, providedArgumentCount: 1 },
      { defaulted: [1, 2], omitted: [1], parameterCount: 3, providedArgumentCount: 1 },
      { defaulted: [1, 2], omitted: [1, 2], parameterCount: 2, providedArgumentCount: 1 },
      { defaulted: [1, 2], omitted: [1, 2], parameterCount: 3, providedArgumentCount: 2 },
      { defaulted: [1, 2], omitted: [], parameterCount: 3, providedArgumentCount: 'dynamic' },
    ] as const;
    for (const replacement of replacements) {
      const invalid = structuredClone(valid);
      const declaration = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
      );
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'call') throw new Error('Expected default-parameter call');
      (expression.semantics as { defaultParameters?: unknown }).defaultParameters = replacement;

      const result = validateIrModuleStructure(invalid);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures).toContainEqual(
          expect.objectContaining({
            code: 'invalid-node-shape',
            path: expect.stringContaining('.semantics.defaultParameters'),
          }),
        );
      }
    }

    const dynamic = lower(
      'spread-default-call.ts',
      'function choose(first: number, second = 2): number { return first; } export function read(values: [number]): number { return choose(...values); }',
    );
    expect(validateIrModuleStructure(dynamic)).toEqual({ kind: 'valid' });
  });

  it('validates exact optional-parameter call arity, ordering, and omissions', () => {
    const valid = lower(
      'optional-call.ts',
      'function choose(first: number, second?: number, third?: number): number { return first; } export function read(): number { return choose(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const replacements = [
      { omitted: [1, 2], optional: [2, 1], parameterCount: 3, provided: [], providedArgumentCount: 1 },
      { omitted: [1], optional: [1, 2], parameterCount: 3, provided: [], providedArgumentCount: 1 },
      { omitted: [1, 2], optional: [1, 2], parameterCount: 2, provided: [], providedArgumentCount: 1 },
      { omitted: [1, 2], optional: [1, 2], parameterCount: 3, provided: [], providedArgumentCount: 2 },
      { omitted: [], optional: [1, 2], parameterCount: 3, provided: [], providedArgumentCount: 'dynamic' },
    ] as const;
    for (const replacement of replacements) {
      const invalid = structuredClone(valid);
      const declaration = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
      );
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'call') throw new Error('Expected optional-parameter call');
      (expression.semantics as { optionalParameters?: unknown }).optionalParameters = replacement;

      const result = validateIrModuleStructure(invalid);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures).toContainEqual(
          expect.objectContaining({
            code: 'invalid-node-shape',
            path: expect.stringContaining('.semantics.optionalParameters'),
          }),
        );
      }
    }

    const dynamic = lower(
      'spread-optional-call.ts',
      'function choose(first: number, second?: number): number { return first; } export function read(values: [number]): number { return choose(...values); }',
    );
    expect(validateIrModuleStructure(dynamic)).toEqual({ kind: 'valid' });

    const mixed = lower(
      'mixed-optional-call.ts',
      'function choose(first?: number, second = 2): number { return second; } export function read(): number { return choose(); }',
    );
    expect(validateIrModuleStructure(mixed)).toEqual({ kind: 'valid' });
    const overlapping = structuredClone(mixed);
    const mixedDeclaration = overlapping.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const mixedStatement = mixedDeclaration?.kind === 'function' ? mixedDeclaration.body[0] : undefined;
    const mixedExpression = mixedStatement?.kind === 'return' ? mixedStatement.expression : undefined;
    if (mixedExpression?.kind !== 'call') throw new Error('Expected mixed-cardinality call');
    (mixedExpression.semantics as { optionalParameters?: unknown }).optionalParameters = {
      omitted: [0, 1],
      optional: [0, 1],
      parameterCount: 2,
      provided: [],
      providedArgumentCount: 0,
    };
    expect(validateIrModuleStructure(overlapping)).toMatchObject({
      failures: [expect.objectContaining({ path: expect.stringContaining('.semantics.optionalParameters') })],
      kind: 'invalid',
    });
  });

  it('validates overload source order and resolved-versus-implementation ABI arity', () => {
    const valid = lower(
      'overload-implementation-call.ts',
      'function choose(value: number): number; function choose(value: number, radix?: number): number; function choose(value: number, radix = 10): number { return value; } export function read(): number { return choose(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    for (const replacement of [
      { implementationParameterCount: -1, overloadIndex: 0, resolvedParameterCount: 1 },
      { implementationParameterCount: 2, overloadIndex: -1, resolvedParameterCount: 1 },
      { implementationParameterCount: 2, overloadIndex: 0, resolvedParameterCount: -1 },
      { implementationParameterCount: 2.5, overloadIndex: 0, resolvedParameterCount: 1 },
      { implementationParameterCount: 3, overloadIndex: 0, resolvedParameterCount: 1 },
    ]) {
      const invalid = structuredClone(valid);
      const declaration = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
      );
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'call') throw new Error('Expected overloaded call');
      (expression.semantics as { overloadImplementation?: unknown }).overloadImplementation = replacement;

      expect(validateIrModuleStructure(invalid)).toMatchObject({
        failures: [expect.objectContaining({ path: expect.stringContaining('.overloadImplementation') })],
        kind: 'invalid',
      });
    }
  });

  it('validates contextual undefined option-value type evidence', () => {
    const valid = lower('contextual-undefined.ts', 'export function maybe(): number | undefined { return undefined; }');
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'undefinedValue') throw new Error('Expected contextual undefined value');
    (expression as { type: unknown }).type = { kind: 'primitive', name: 'number' };

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures).toContainEqual(
        expect.objectContaining({ code: 'invalid-node-shape', path: expect.stringContaining('.type') }),
      );
    }
  });

  it('validates statement-value carriers through their final value completion', () => {
    const module = lower(
      'statement-value.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const declaration = module.declarations[0];
    const returnStatement = declaration?.kind === 'function' ? declaration.body[1] : undefined;
    const expression = returnStatement?.kind === 'return' ? returnStatement.expression : undefined;
    if (declaration?.kind !== 'function' || expression?.kind !== 'call' || expression.callee.kind !== 'function') {
      throw new Error('Expected statement-value carrier');
    }
    const completion = expression.callee.body.at(-1);
    if (completion?.kind !== 'return') throw new Error('Expected statement-value completion');
    const invalidExpression = {
      ...expression,
      callee: {
        ...expression.callee,
        body: [...expression.callee.body.slice(0, -1), { ...completion, expression: undefined }],
      },
    };
    const invalid = {
      ...module,
      declarations: [
        {
          ...declaration,
          body: [declaration.body[0]!, { ...returnStatement, expression: invalidExpression }],
        },
      ],
    } as IrModule;

    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });
    expect(validateIrModuleStructure(invalid)).toMatchObject({
      failures: [{ code: 'invalid-node-shape', path: expect.stringContaining('statementValue') }],
      kind: 'invalid',
    });
  });

  it('validates labeled control-flow targets against active and continuable identities', () => {
    const valid = lower(
      'labeled-flow.ts',
      'export function scan(): void { outer: while (true) { if (true) continue outer; break outer; } }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const dangling = structuredClone(valid);
    const declaration = dangling.declarations[0];
    const loop = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const first = loop?.kind === 'while' && loop.body.kind === 'block' ? loop.body.statements[0] : undefined;
    const continued = first?.kind === 'if' ? first.consequent : undefined;
    if (continued?.kind !== 'continue' || !continued.target) throw new Error('Expected labeled continue target');
    (continued.target as { id: string }).id = 'control-flow-label:missing';

    const nonLoop = lower('labeled-block.ts', 'export function scan(): void { outer: { continue outer; } }');
    for (const module of [dangling, nonLoop]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures).toContainEqual(
          expect.objectContaining({ code: 'invalid-node-shape', path: expect.stringContaining('.target') }),
        );
      }
    }
  });

  it('accepts exact repeated function-scoped variable declarations but not other duplicate introductions', () => {
    const repeated = lower(
      'repeated-var.ts',
      'export function choose(): number { var value: number = 1; var value: number; value = 2; return value; }',
    );
    const declaration = repeated.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const first = declaration.body[0];
    const second = declaration.body[1];
    if (first?.kind !== 'variable' || second?.kind !== 'variable') {
      throw new Error('Expected repeated variable declarations');
    }
    const firstVariable = first.declarations[0];
    const secondVariable = second.declarations[0];
    if (!firstVariable || !secondVariable || 'pattern' in firstVariable || 'pattern' in secondVariable) {
      throw new Error('Expected named repeated variable declarations');
    }

    expect(firstVariable).toMatchObject({ binding: secondVariable.binding });
    expect(validateIrModuleStructure(repeated)).toEqual({ kind: 'valid' });
  });

  it('rejects references that escape sibling functions, nested blocks, catch clauses, or loop scopes', () => {
    const redirectReturn = (statement: Readonly<IrStatement> | undefined, binding: IrBindingIdentity): IrStatement => {
      if (statement?.kind !== 'return' || statement.expression?.kind !== 'identifier') {
        throw new Error('Expected identifier return');
      }
      return { ...statement, expression: { ...statement.expression, reference: { binding, kind: 'binding' } } };
    };
    const expectOutOfScope = (value: IrModule) => {
      const result = validateIrModuleStructure(value);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('out-of-scope-binding-reference');
      }
    };

    const functions = lower(
      'sibling-functions.ts',
      `
        export function first(value: number): number { return value; }
        export function second(value: number): number { return value; }
      `,
    );
    const [first, second] = functions.declarations;
    if (first?.kind !== 'function' || second?.kind !== 'function' || !first.parameters[0]) {
      throw new Error('Expected sibling functions');
    }
    expectOutOfScope({
      ...functions,
      declarations: [first, { ...second, body: [redirectReturn(second.body[0], first.parameters[0].binding)] }],
    });

    const blocks = lower(
      'nested-block.ts',
      `
        export function block(): number {
          { const hidden = 1; hidden; }
          const visible = 2;
          return visible;
        }
      `,
    );
    const blockFunction = blocks.declarations[0];
    if (blockFunction?.kind !== 'function' || blockFunction.body[0]?.kind !== 'block') {
      throw new Error('Expected block function');
    }
    const hiddenStatement = blockFunction.body[0].statements[0];
    if (hiddenStatement?.kind !== 'variable' || !hiddenStatement.declarations[0]) {
      throw new Error('Expected hidden block binding');
    }
    if ('pattern' in hiddenStatement.declarations[0]) throw new Error('Expected named hidden block binding');
    expectOutOfScope({
      ...blocks,
      declarations: [
        {
          ...blockFunction,
          body: [
            blockFunction.body[0],
            blockFunction.body[1]!,
            redirectReturn(blockFunction.body[2], hiddenStatement.declarations[0].binding),
          ],
        },
      ],
    });

    const controls = lower(
      'control-scopes.ts',
      `
        export function control(values: number[]): number {
          for (const value of values) { value; }
          try { throw 1; } catch (error) { error; }
          const fallback = 1;
          return fallback;
        }
      `,
    );
    const control = controls.declarations[0];
    if (
      control?.kind !== 'function' ||
      control.body[0]?.kind !== 'forOf' ||
      control.body[1]?.kind !== 'try' ||
      !control.body[1].catchClause?.binding
    ) {
      throw new Error('Expected loop and catch bindings');
    }
    if ('pattern' in control.body[0].variable) throw new Error('Expected named loop binding');
    for (const binding of [control.body[0].variable.binding, control.body[1].catchClause.binding]) {
      expectOutOfScope({
        ...controls,
        declarations: [
          {
            ...control,
            body: [control.body[0], control.body[1], control.body[2]!, redirectReturn(control.body[3], binding)],
          },
        ],
      });
    }
  });

  it('validates array binding pattern origins, scopes, nesting, defaults, rest, and leaf identity', () => {
    const module = lower('patterns.ts', 'export const values: number[] = [1, 2, 3];');
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'variable' || 'pattern' in declaration) {
      throw new Error('Expected named variable declaration');
    }
    const nestedBinding: IrBindingIdentity = {
      ...declaration.binding,
      id: `${declaration.binding.id}:nested`,
      name: 'nested',
    };
    const restBinding: IrBindingIdentity = {
      ...declaration.binding,
      id: `${declaration.binding.id}:rest`,
      name: 'remaining',
    };
    const pattern: IrArrayBindingPattern = {
      ...declaration.origin,
      elements: [
        undefined,
        {
          initializer: { kind: 'literal', value: 0 },
          pattern: {
            binding: declaration.binding,
            kind: 'binding',
            type: { kind: 'primitive', name: 'number' },
          },
        },
        {
          pattern: {
            ...declaration.origin,
            elements: [{ pattern: { binding: nestedBinding, kind: 'binding' } }],
            kind: 'array',
            scope: 'module',
          },
        },
      ],
      kind: 'array',
      rest: { binding: restBinding, kind: 'binding' },
      scope: 'module',
    };
    const patternedDeclaration: IrVariableDeclaration = {
      exported: declaration.exported,
      initializer: declaration.initializer,
      kind: 'variable',
      mutable: declaration.mutable,
      origin: declaration.origin,
      pattern,
      type: declaration.type,
    };
    const patternedModule: IrModule = { ...module, declarations: [patternedDeclaration] };
    const snapshot = structuredClone(patternedModule);

    expect(validateIrModuleStructure(patternedModule)).toEqual({ kind: 'valid' });
    expect(validateIrModuleStructure(patternedModule)).toEqual(validateIrModuleStructure(patternedModule));
    expect(patternedModule).toEqual(snapshot);

    const invalidPatterns: readonly [IrArrayBindingPattern, CompilerIrModuleValidationFailureCode][] = [
      [{ ...pattern, fingerprint: 'sha256:invalid' }, 'invalid-binding-origin'],
      [{ ...pattern, scope: 'block' }, 'invalid-binding-introduction'],
      [{ ...pattern, rest: { binding: declaration.binding, kind: 'binding' } }, 'duplicate-binding-identity'],
      [{ ...pattern, elements: [{ pattern: { kind: 'invalid' } as never }] }, 'unknown-ir-kind'],
    ];
    for (const [invalidPattern, code] of invalidPatterns) {
      const result = validateIrModuleStructure({
        ...patternedModule,
        declarations: [{ ...patternedDeclaration, pattern: invalidPattern }],
      });
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain(code);
    }
  });

  it('validates object binding keys, defaults, nesting, rest, and leaf identity', () => {
    const module = lower(
      'object-pattern.ts',
      `
        const key = 'other';
        export const { value: renamed = 1, nested: { text }, [key]: computed, ...rest }:
          { value?: number; nested: { text: string }; other: boolean } =
          { nested: { text: 'flight' }, other: true };
      `,
    );
    const declaration = module.declarations.find(
      (item) => item.kind === 'variable' && 'pattern' in item && item.pattern.kind === 'object',
    );
    if (declaration?.kind !== 'variable' || !('pattern' in declaration) || declaration.pattern.kind !== 'object') {
      throw new Error('Expected object binding declaration');
    }
    const snapshot = structuredClone(module);

    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });
    expect(module).toEqual(snapshot);

    const emptyKey = {
      ...declaration.pattern,
      properties: [
        { ...declaration.pattern.properties[0]!, key: { kind: 'named' as const, name: '' } },
        ...declaration.pattern.properties.slice(1),
      ],
    };
    const nestedRest = { ...declaration.pattern, rest: declaration.pattern };
    for (const pattern of [emptyKey, nestedRest]) {
      const result = validateIrModuleStructure({
        ...module,
        declarations: [{ ...declaration, pattern }],
      });
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('reports stable identity, origin, reference, cardinality, arity, kind, and shape failures', () => {
    const module = lower('identity.ts', 'export function identity<T>(value: T): T { return value; }');
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const parameter = declaration.parameters[0]!;
    const returned = declaration.body[0];
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'identifier') {
      throw new Error('Expected returned identifier');
    }
    const returnedExpression = returned.expression;
    if (returnedExpression.reference.kind !== 'binding') throw new Error('Expected binding reference');
    const bindingReference = returnedExpression.reference;
    const withReferenceBinding = (binding: IrBindingIdentity): IrModule => ({
      ...module,
      declarations: [
        {
          ...declaration,
          body: [
            {
              ...returned,
              expression: {
                ...returnedExpression,
                reference: { ...bindingReference, binding },
              },
            },
          ],
        },
      ],
    });
    const inconsistentReferences: readonly IrBindingIdentity[] = [
      { ...bindingReference.binding, space: 'type' } as unknown as IrBindingIdentity,
      { ...bindingReference.binding, kind: 'variable' },
      { ...bindingReference.binding, scope: 'module' },
      { ...bindingReference.binding, packageName: '@flighthq/other' },
      { ...bindingReference.binding, source: `${bindingReference.binding.source}.other` },
      { ...bindingReference.binding, line: bindingReference.binding.line + 1 },
      { ...bindingReference.binding, column: bindingReference.binding.column + 1 },
      { ...bindingReference.binding, fingerprint: `${bindingReference.binding.fingerprint}:changed` },
    ];
    const typeModule = lower('compound.ts', 'export type Compound = string | number;');
    const typeDeclaration = typeModule.declarations[0];
    if (typeDeclaration?.kind !== 'typeAlias' || typeDeclaration.type.kind !== 'union') {
      throw new Error('Expected union type alias');
    }
    const invalidKind = { kind: 'invalid' };
    const initializedParameter = {
      ...parameter,
      initializer: { kind: 'literal', value: 1 },
      optional: false,
      rest: false,
    };
    const throwingModule = {
      ...module,
      get declarations(): IrModule['declarations'] {
        const failure: unknown = 'broken declaration list';
        throw failure;
      },
    };
    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });
    const malformed: readonly [IrModule, CompilerIrModuleValidationFailureCode][] = [
      [{ ...module, name: '' }, 'invalid-module-identity'],
      [{ ...module, packageName: '' }, 'invalid-module-identity'],
      [{ ...module, source: '' }, 'invalid-module-identity'],
      [
        {
          ...module,
          declarations: [{ ...declaration, binding: { ...declaration.binding, id: '' } }],
        },
        'invalid-binding-identity',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, binding: { ...declaration.binding, scope: 'function' } }],
        },
        'invalid-binding-introduction',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              parameters: [{ ...parameter, binding: { ...parameter.binding, kind: 'variable' } }],
            },
          ],
        },
        'invalid-binding-introduction',
      ],
      [
        {
          ...typeModule,
          declarations: [
            {
              ...typeDeclaration,
              binding: { ...typeDeclaration.binding, kind: 'import' },
            },
          ],
        },
        'invalid-binding-introduction',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, binding: { ...declaration.binding, packageName: '@flighthq/other' } }],
        },
        'invalid-binding-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, binding: { ...declaration.binding, fingerprint: 'sha256:invalid' } }],
        },
        'invalid-binding-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, fingerprint: 'sha256:invalid' } }],
        },
        'invalid-declaration-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, source: 'other.ts' } }],
        },
        'invalid-declaration-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, line: 0 } }],
        },
        'invalid-declaration-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, line: 1.5 } }],
        },
        'invalid-declaration-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, column: 0 } }],
        },
        'invalid-declaration-origin',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, origin: { ...declaration.origin, column: 1.5 } }],
        },
        'invalid-declaration-origin',
      ],
      [{ ...module, declarations: [declaration, declaration] }, 'duplicate-binding-identity'],
      [withReferenceBinding({ ...bindingReference.binding, id: 'missing' }), 'dangling-binding-reference'],
      ...inconsistentReferences.map((binding): [IrModule, CompilerIrModuleValidationFailureCode] => [
        withReferenceBinding(binding),
        'inconsistent-binding-reference',
      ]),
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              parameters: [{ ...parameter, optional: true, rest: true }],
            },
          ],
        } as unknown as IrModule,
        'invalid-parameter-cardinality',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, parameters: [initializedParameter] }],
        } as unknown as IrModule,
        'invalid-parameter-cardinality',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              parameters: [
                { ...parameter, optional: false, rest: true },
                { ...parameter, binding: { ...parameter.binding, id: `${parameter.binding.id}:second` } },
              ],
            },
          ],
        } as unknown as IrModule,
        'invalid-parameter-cardinality',
      ],
      [
        {
          ...typeModule,
          declarations: [
            {
              ...typeDeclaration,
              type: { ...typeDeclaration.type, types: [typeDeclaration.type.types[0]!] },
            },
          ],
        } as unknown as IrModule,
        'invalid-compound-type-arity',
      ],
      [{ ...module, declarations: undefined } as unknown as IrModule, 'invalid-node-shape'],
      [throwingModule, 'invalid-node-shape'],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: { kind: 'tupleRest', object: { elements: [], kind: 'array' }, start: -1 },
                  kind: 'return',
                },
              ],
            },
          ],
        },
        'invalid-node-shape',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: {
                    kind: 'tupleSuffix',
                    object: { kind: 'identifier', reference: { binding: parameter.binding, kind: 'binding' } },
                    start: -1,
                    width: 0,
                  },
                  kind: 'return',
                },
              ],
            },
          ],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: {
                    kind: 'tupleSuffix',
                    object: { kind: 'identifier', reference: { binding: parameter.binding, kind: 'binding' } },
                    start: 0,
                    width: -1,
                  },
                  kind: 'return',
                },
              ],
            },
          ],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: {
                    kind: 'tupleSuffix',
                    object: { elements: [], kind: 'array' },
                    start: 0,
                    width: 0,
                  },
                  kind: 'return',
                },
              ],
            },
          ],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: { elements: [{ optional: false }], kind: 'tuple' },
                  kind: 'return',
                },
              ],
            },
          ],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
      [{ ...module, declarations: [invalidKind] } as unknown as IrModule, 'unknown-ir-kind'],
      [{ ...module, exports: [invalidKind] } as unknown as IrModule, 'unknown-ir-kind'],
      [
        { ...module, exports: [{ expression: invalidKind, kind: 'default' }] } as unknown as IrModule,
        'unknown-ir-kind',
      ],
      [
        {
          ...module,
          exports: [{ expression: { kind: 'object', members: [invalidKind] }, kind: 'default' }],
        } as unknown as IrModule,
        'unknown-ir-kind',
      ],
      [
        {
          ...module,
          declarations: [{ ...declaration, body: [invalidKind] }],
        } as unknown as IrModule,
        'unknown-ir-kind',
      ],
      [
        {
          ...typeModule,
          declarations: [{ ...typeDeclaration, type: invalidKind }],
        } as unknown as IrModule,
        'unknown-ir-kind',
      ],
    ];

    for (const [value, code] of malformed) {
      const result = validateIrModuleStructure(value);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain(code);
    }
  });
});

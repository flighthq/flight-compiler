import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerIrModuleValidationFailureCode,
  IrArrayBindingPattern,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
  IrType,
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

  it('validates class method overload signatures in independent function scopes', () => {
    const valid = lower(
      'method-overloads.ts',
      `
        export class Picker {
          choose(value: number): number;
          choose(value: number, radix?: number): number;
          choose(value: number, radix = 10): number { return value + radix; }
        }
      `,
    );

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'class' || !declaration.methods[0]?.overloads[0]) {
      throw new Error('Expected overloaded class method');
    }
    (declaration.methods[0].overloads[0] as { returns: unknown }).returns = { kind: 'future-type' };
    expect(validateIrModuleStructure(invalid)).toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'unknown-ir-kind',
          path: expect.stringContaining('.methods[0].overloads[0].returns'),
        }),
      ],
      kind: 'invalid',
    });
  });

  it('requires every function expression to state lexical or dynamic this semantics', () => {
    const module = lower(
      'function-this.ts',
      'export const lexical = () => 1; export const dynamic = function () { return 1; };',
    );
    const expressions = module.declarations.flatMap((declaration) =>
      declaration.kind === 'variable' && declaration.initializer?.kind === 'function' ? [declaration.initializer] : [],
    );

    expect(expressions.map((expression) => expression.thisMode)).toEqual(['lexical', 'dynamic']);
    const invalid = structuredClone(module);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'variable' || declaration.initializer?.kind !== 'function') {
      throw new Error('Expected function-valued variable');
    }
    (declaration.initializer as { thisMode: unknown }).thisMode = 'unknown';

    expect(validateIrModuleStructure(invalid)).toMatchObject({
      failures: [
        expect.objectContaining({ code: 'invalid-node-shape', path: '$.declarations[0].initializer.thisMode' }),
      ],
      kind: 'invalid',
    });
  });

  it('validates union member test evidence, its binding, member type, and equality operator', () => {
    const valid = lower(
      'union-member-test.ts',
      `export function isText(value: string | number): boolean { return typeof value === 'string'; }`,
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalidOperator = structuredClone(valid);
    const invalidResult = structuredClone(valid);
    const invalidType = structuredClone(valid);
    for (const [module, change] of [
      [invalidOperator, 'operator'],
      [invalidResult, 'result'],
      [invalidType, 'type'],
    ] as const) {
      const declaration = module.declarations[0];
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'binary' || !expression.semantics.unionMemberTest) {
        throw new Error('Expected union member test');
      }
      if (change === 'operator') (expression as { operator: string }).operator = '+';
      if (change === 'result') {
        (expression.semantics.unionMemberTest as { whenResult: unknown }).whenResult = 'true';
      }
      if (change === 'type') {
        (expression.semantics.unionMemberTest as { member: unknown }).member = { kind: 'future-type' };
      }
    }

    for (const module of [invalidOperator, invalidResult, invalidType]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain(
          module === invalidType ? 'unknown-ir-kind' : 'invalid-node-shape',
        );
      }
    }
  });

  it('requires exact versioned await semantics', () => {
    const valid = lower(
      'await.ts',
      'export async function read(task: Promise<number>): Promise<number> { return await task; }',
    );
    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'return') {
      throw new Error('Expected async return');
    }
    const expression = declaration.body[0].expression;
    if (expression?.kind !== 'await') throw new Error('Expected await expression');
    (expression as { semantics: unknown }).semantics = {
      ...expression.semantics,
      continuation: 'inline',
    };

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    expect(validateIrModuleStructure(invalid)).toMatchObject({
      failures: [
        expect.objectContaining({
          code: 'invalid-node-shape',
          path: expect.stringContaining('.semantics'),
        }),
      ],
      kind: 'invalid',
    });
  });

  it('requires exact catch semantics consistent with binding presence', () => {
    const valid = lower(
      'catch.ts',
      'export function bound(): void { try { throw 1; } catch (error) { throw error; } } export function unbound(): void { try { throw 1; } catch {} }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const variants = [structuredClone(valid), structuredClone(valid), structuredClone(valid)];
    const boundStatements = variants.map((variant) => {
      const declaration = variant.declarations[0];
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      if (statement?.kind !== 'try' || !statement.catchClause) throw new Error('Expected bound catch clause');
      return statement.catchClause;
    });
    const unboundDeclaration = variants[2]!.declarations[1];
    const unboundStatement = unboundDeclaration?.kind === 'function' ? unboundDeclaration.body[0] : undefined;
    if (unboundStatement?.kind !== 'try' || !unboundStatement.catchClause) {
      throw new Error('Expected unbound catch clause');
    }
    (boundStatements[0] as { semantics: unknown }).semantics = {
      ...boundStatements[0]!.semantics,
      extra: true,
    };
    (boundStatements[1] as { semantics: unknown }).semantics = {
      ...boundStatements[1]!.semantics,
      bindingInitialization: { kind: 'discard' },
    };
    (unboundStatement.catchClause as { semantics: unknown }).semantics = {
      ...unboundStatement.catchClause.semantics,
      bindingInitialization: { kind: 'initialize', source: 'thrown-value', timing: 'before-body' },
    };

    for (const variant of variants) {
      expect(validateIrModuleStructure(variant)).toMatchObject({
        failures: [
          expect.objectContaining({
            code: 'invalid-node-shape',
            path: expect.stringContaining('.catchClause.semantics'),
          }),
        ],
        kind: 'invalid',
      });
    }
  });

  it('validates parameter-property identity against its constructor layout', () => {
    const module = lower(
      'parameter-property.ts',
      'export class Value { constructor(public readonly value: number, protected label: string) {} }',
    );
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'class' || !declaration.fields[0]?.parameterProperty) {
      throw new Error('Expected parameter property');
    }
    const field = declaration.fields[0];
    const variants: IrModule[] = [
      {
        ...module,
        declarations: [
          {
            ...declaration,
            fields: [{ ...field, parameterProperty: { parameterIndex: 99 } }],
          },
        ],
      },
      {
        ...module,
        declarations: [{ ...declaration, fields: [{ ...field, static: true }] }],
      },
      {
        ...module,
        declarations: [{ ...declaration, fields: [{ ...field, name: 'other' }] }],
      },
      {
        ...module,
        declarations: [{ ...declaration, fields: [field, field] }],
      },
    ];

    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });
    for (const variant of variants) {
      expect(validateIrModuleStructure(variant)).toMatchObject({
        failures: [expect.objectContaining({ code: 'invalid-node-shape' })],
        kind: 'invalid',
      });
    }
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

  it('requires exact module variable declaration kind and mutability agreement', () => {
    const valid = lower(
      'module-declaration-kind.ts',
      'export const fixed = 1; export let temporal = 2; export var available = 3;',
    );

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    for (const mutation of [
      { declarationKind: 'using' },
      { declarationKind: 'const', mutable: true },
      { declarationKind: 'let', mutable: false },
      { declarationKind: 'var', mutable: false },
    ]) {
      const invalid = structuredClone(valid);
      Object.assign(invalid.declarations[0]!, mutation);
      const result = validateIrModuleStructure(invalid);

      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('requires declaration-level type-only identity to agree with import bindings', () => {
    const valid = lower(
      'import-type-only.ts',
      "import type { Shape } from './shape.js'; import { value } from './value.js'; export type Alias = Shape; value;",
    );
    const missing = structuredClone(valid);
    const conflicting = structuredClone(valid);
    delete (missing.imports[0] as { typeOnly?: boolean }).typeOnly;
    Object.assign(conflicting.imports[1]!, { typeOnly: true });

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    for (const module of [missing, conflicting]) {
      expect(validateIrModuleStructure(module)).toMatchObject({
        failures: [expect.objectContaining({ code: 'invalid-node-shape', path: expect.stringContaining('typeOnly') })],
        kind: 'invalid',
      });
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

  it('requires exact copy semantics precisely when an object expression contains spread', () => {
    const valid = lower(
      'object-copy.ts',
      'export function copy(source: { value: number }) { return { before: 1, ...source, value: 2 }; }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const missing = structuredClone(valid);
    const missingDeclaration = missing.declarations[0];
    const missingReturn = missingDeclaration?.kind === 'function' ? missingDeclaration.body[0] : undefined;
    const missingExpression = missingReturn?.kind === 'return' ? missingReturn.expression : undefined;
    if (missingExpression?.kind !== 'object') throw new Error('Expected object copy expression');
    delete (missingExpression as { copySemantics?: unknown }).copySemantics;

    const malformed = structuredClone(valid);
    const malformedDeclaration = malformed.declarations[0];
    const malformedReturn = malformedDeclaration?.kind === 'function' ? malformedDeclaration.body[0] : undefined;
    const malformedExpression = malformedReturn?.kind === 'return' ? malformedReturn.expression : undefined;
    if (malformedExpression?.kind !== 'object' || !malformedExpression.copySemantics) {
      throw new Error('Expected object copy semantics');
    }
    (malformedExpression.copySemantics as { targetWrites: unknown }).targetWrites = 'assign';

    const unnecessary = structuredClone(valid);
    const unnecessaryDeclaration = unnecessary.declarations[0];
    const unnecessaryReturn = unnecessaryDeclaration?.kind === 'function' ? unnecessaryDeclaration.body[0] : undefined;
    const unnecessaryExpression = unnecessaryReturn?.kind === 'return' ? unnecessaryReturn.expression : undefined;
    if (unnecessaryExpression?.kind !== 'object') throw new Error('Expected object copy expression');
    (unnecessaryExpression as unknown as { members: unknown[] }).members = unnecessaryExpression.members.filter(
      (member) => member.kind !== 'spread',
    );

    for (const module of [missing, malformed, unnecessary]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures).toContainEqual(
          expect.objectContaining({
            code: 'invalid-node-shape',
            path: expect.stringContaining('.copySemantics'),
          }),
        );
      }
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

    const classified = lower(
      'classified-default-call.ts',
      'function choose(value: number | null = 1): number | null { return value; } export function read(): number | null { return choose(null); }',
    );
    const classifiedDeclaration = classified.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const classifiedStatement = classifiedDeclaration?.kind === 'function' ? classifiedDeclaration.body[0] : undefined;
    const classifiedExpression = classifiedStatement?.kind === 'return' ? classifiedStatement.expression : undefined;
    if (classifiedExpression?.kind !== 'call' || !classifiedExpression.semantics.defaultParameters?.provided[0]) {
      throw new Error('Expected classified default call');
    }
    (
      classifiedExpression.semantics.defaultParameters.provided[0] as {
        value: string;
      }
    ).value = 'missing';
    expect(validateIrModuleStructure(classified)).toMatchObject({
      failures: [expect.objectContaining({ path: expect.stringContaining('.semantics.defaultParameters') })],
      kind: 'invalid',
    });
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

  it('validates neutral extra-argument erasure carrier identities and result type evidence', () => {
    const valid = lower(
      'extra-argument.ts',
      'function choose(value: number): number { return value; } export function read(): number { return choose(1, 2); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    for (const mutate of [
      (expression: Extract<IrExpression, { kind: 'call' }>) => {
        const bindings = expression.semantics.extraArguments?.argumentBindings;
        if (!bindings) throw new Error('Expected erasure bindings');
        (expression.semantics.extraArguments as { argumentBindings: unknown }).argumentBindings = [
          bindings[0],
          bindings[0],
        ];
      },
      (expression: Extract<IrExpression, { kind: 'call' }>) => {
        (expression.semantics.extraArguments as { resultType: unknown }).resultType = { kind: 'future-type' };
      },
      (expression: Extract<IrExpression, { kind: 'call' }>) => {
        (expression.semantics as { signature?: unknown }).signature = undefined;
      },
    ]) {
      const invalid = structuredClone(valid);
      const declaration = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
      );
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'call') throw new Error('Expected extra-argument call');
      mutate(expression);

      expect(validateIrModuleStructure(invalid)).toMatchObject({
        failures: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining('.semantics.extraArguments') }),
        ]),
        kind: 'invalid',
      });
    }

    const invalidOrigin = structuredClone(valid);
    const declaration = invalidOrigin.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    const binding = expression?.kind === 'call' ? expression.semantics.extraArguments?.argumentBindings[0] : undefined;
    if (!binding) throw new Error('Expected extra-argument carrier binding');
    (binding as { source: string }).source = 'other.ts';
    expect(validateIrModuleStructure(invalidOrigin)).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-binding-origin', path: expect.stringContaining('argumentBindings') }),
      ]),
      kind: 'invalid',
    });
  });

  it('validates call and constructor overload source order and resolved-versus-implementation ABI arity', () => {
    const valid = lower(
      'overload-implementation-call.ts',
      'function choose(value: number): number; function choose(value: number, radix?: number): number; function choose(value: number, radix = 10): number { return value; } export function read(): number { return choose(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    const rest = lower(
      'rest-implementation-call.ts',
      'function collect(first: number, ...rest: number[]): number { return first; } export function read(): number { return collect(1, 2, 3); }',
    );
    expect(validateIrModuleStructure(rest)).toEqual({ kind: 'valid' });

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
        failures: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining('.overloadImplementation') }),
        ]),
        kind: 'invalid',
      });
    }

    const constructor = lower(
      'overload-constructor-call.ts',
      'class Box { constructor(value: number); constructor(value: number, radix?: number); constructor(value: number, radix = 10) {} } export function create(): Box { return new Box(1); }',
    );
    expect(validateIrModuleStructure(constructor)).toEqual({ kind: 'valid' });
    const invalidConstructor = structuredClone(constructor);
    const create = invalidConstructor.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'create',
    );
    const createStatement = create?.kind === 'function' ? create.body[0] : undefined;
    const newExpression = createStatement?.kind === 'return' ? createStatement.expression : undefined;
    if (newExpression?.kind !== 'new') throw new Error('Expected overloaded constructor call');
    (newExpression.semantics as { overloadImplementation?: unknown }).overloadImplementation = {
      implementationParameterCount: 1,
      overloadIndex: 0,
      resolvedParameterCount: 1,
    };
    expect(validateIrModuleStructure(invalidConstructor)).toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('.overloadImplementation') }),
      ]),
      kind: 'invalid',
    });

    for (const replacement of [
      { parameterCount: -1, providedArgumentCount: 1 },
      { parameterCount: 2, providedArgumentCount: 0 },
      { parameterCount: 2, providedArgumentCount: 'dynamic' as const },
      { parameterCount: 2, providedArgumentCount: 1, restParameter: 0 },
    ]) {
      const invalid = structuredClone(constructor);
      const declaration = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'create',
      );
      const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
      const expression = statement?.kind === 'return' ? statement.expression : undefined;
      if (expression?.kind !== 'new') throw new Error('Expected overloaded constructor call');
      (expression.semantics as { signature?: unknown }).signature = replacement;

      expect(validateIrModuleStructure(invalid)).toMatchObject({
        failures: [expect.objectContaining({ path: expect.stringContaining('.signature') })],
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
      declarationKind: 'const',
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
                  expression: { kind: 'tupleRest', object: { elements: [], kind: 'array' }, start: 0.5 },
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
                    start: 0.5,
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
                    object: { kind: 'identifier', reference: { binding: parameter.binding, kind: 'binding' } },
                    start: 0,
                    width: 0.5,
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
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  expression: {
                    excluded: [{ kind: 'computed', coercion: 'invalid', expression: { kind: 'literal', value: 'a' } }],
                    kind: 'objectRest',
                    object: { kind: 'identifier', reference: { binding: parameter.binding, kind: 'binding' } },
                    type: { kind: 'object', properties: [] },
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
                    excluded: [{ kind: 'named', name: '' }],
                    kind: 'objectRest',
                    object: { kind: 'identifier', reference: { binding: parameter.binding, kind: 'binding' } },
                    type: { kind: 'object', properties: [] },
                  },
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
          exports: [{ expression: { kind: 'object', members: [] }, kind: 'default' }],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
      [
        {
          ...module,
          exports: [
            {
              expression: { kind: 'object', members: [invalidKind], type: { kind: 'unknown', source: 'object' } },
              kind: 'default',
            },
          ],
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
      [
        {
          ...typeModule,
          declarations: [
            {
              ...typeDeclaration,
              type: {
                kind: 'object',
                properties: [
                  { name: 'value', optional: false, readonly: false, type: { kind: 'primitive', name: 'number' } },
                  { name: 'value', optional: false, readonly: false, type: { kind: 'primitive', name: 'number' } },
                ],
              },
            },
          ],
        } as unknown as IrModule,
        'invalid-node-shape',
      ],
    ];

    for (const [value, code] of malformed) {
      const result = validateIrModuleStructure(value);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain(code);
    }
  });

  it('validates object rest with computed and named excluded keys', () => {
    const valid = lower(
      'object-rest.ts',
      "export function rest(source: { a: number; b: string }): Omit<typeof source, 'a'> { const { a, ...remaining } = source; a; return remaining; }",
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
  });

  it('validates undefined-default expression from destructuring assignment defaults', () => {
    const valid = lower(
      'undefined-default.ts',
      "export function assign(source: { name?: string }): string { let name = ''; ({ name = 'flight' } = source); return name; }",
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
  });

  it('validates call expression type arguments', () => {
    const valid = lower(
      'generic-call.ts',
      'function identity<T>(value: T): T { return value; } export function read(): number { return identity<number>(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
  });

  it('validates tuple expression element optional flags and required values', () => {
    const module = lower('tuple-expression.ts', 'export const pair: [number, string] = [1, "flight"];');
    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });

    const declaration = module.declarations[0];
    if (declaration?.kind !== 'variable' || declaration.initializer?.kind !== 'tuple') {
      throw new Error('Expected tuple expression');
    }
    const element = declaration.initializer.elements[0]!;

    const nonBoolOptional = structuredClone(module);
    const nonBoolDecl = nonBoolOptional.declarations[0];
    if (nonBoolDecl?.kind !== 'variable' || nonBoolDecl.initializer?.kind !== 'tuple') {
      throw new Error('Expected tuple');
    }
    (nonBoolDecl.initializer.elements[0] as { optional: unknown }).optional = 'false';

    const missingExpression = structuredClone(module);
    const missingDecl = missingExpression.declarations[0];
    if (missingDecl?.kind !== 'variable' || missingDecl.initializer?.kind !== 'tuple') {
      throw new Error('Expected tuple');
    }
    (missingDecl.initializer.elements[0] as { expression?: unknown }).expression = undefined;

    for (const variant of [nonBoolOptional, missingExpression]) {
      const result = validateIrModuleStructure(variant);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('validates tuple spread segment element optional and required constraints', () => {
    const valid = lower(
      'tuple-spread-element.ts',
      "type Pair = [number, string]; const pair: Pair = [1, 'flight']; export const value: [boolean, number, string] = [true, ...pair];",
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const declaration = valid.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (declaration?.kind !== 'variable' || declaration.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread variable');
    }
    const segment = declaration.initializer.segments.find((segment) => segment.kind === 'element');
    if (!segment || segment.kind !== 'element') throw new Error('Expected element segment');

    const nonBoolOptional = structuredClone(valid);
    const nonBoolDecl = nonBoolOptional.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (nonBoolDecl?.kind !== 'variable' || nonBoolDecl.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread');
    }
    const nonBoolSeg = nonBoolDecl.initializer.segments.find((segment) => segment.kind === 'element');
    if (!nonBoolSeg || nonBoolSeg.kind !== 'element') throw new Error('Expected element');
    (nonBoolSeg.element as { optional: unknown }).optional = 'false';

    const missingExpression = structuredClone(valid);
    const missingDecl = missingExpression.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (missingDecl?.kind !== 'variable' || missingDecl.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread');
    }
    const missingSeg = missingDecl.initializer.segments.find((segment) => segment.kind === 'element');
    if (!missingSeg || missingSeg.kind !== 'element') throw new Error('Expected element');
    (missingSeg.element as { expression?: unknown }).expression = undefined;

    for (const variant of [nonBoolOptional, missingExpression]) {
      const result = validateIrModuleStructure(variant);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('rejects duplicate control-flow label identity', () => {
    const valid = lower(
      'nested-labels.ts',
      'export function scan(): void { outer: for (let i = 0; i < 1; i++) { inner: for (let j = 0; j < 1; j++) { break outer; } } }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const outerFor = declaration.body[0];
    if (outerFor?.kind !== 'for' || !outerFor.label) throw new Error('Expected outer for');
    const innerBlock = outerFor.body;
    if (innerBlock.kind !== 'block') throw new Error('Expected block body');
    const innerFor = innerBlock.statements[0];
    if (innerFor?.kind !== 'for' || !innerFor.label) throw new Error('Expected inner for');
    (innerFor.label as { id: string }).id = outerFor.label.id;

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('validates for-in with closed-record key plan on identifier object', () => {
    const valid = lower(
      'for-in-identifier.ts',
      'export function scan(source: { a: number; b: string }): string { for (const key in source) return key; return ""; }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'forIn') {
      throw new Error('Expected for-in statement');
    }
    if (declaration.body[0].keyPlan?.kind !== 'closedRecord') {
      throw new Error('Expected closedRecord key plan');
    }
    (declaration.body[0] as { keyPlan: { evaluation: string } }).keyPlan.evaluation = 'elide';
    expect(validateIrModuleStructure(invalid)).toMatchObject({
      failures: [expect.objectContaining({ code: 'invalid-node-shape', path: expect.stringContaining('.keyPlan') })],
      kind: 'invalid',
    });
  });

  it('requires primitive string type evidence on for-in bindings', () => {
    const valid = lower(
      'for-in-binding-type.ts',
      'export function scan(source: { a: number }): string { for (const key in source) return key; return ""; }',
    );
    const missing = structuredClone(valid);
    const wrong = structuredClone(valid);
    const missingDeclaration = missing.declarations[0];
    const wrongDeclaration = wrong.declarations[0];
    if (
      missingDeclaration?.kind !== 'function' ||
      missingDeclaration.body[0]?.kind !== 'forIn' ||
      wrongDeclaration?.kind !== 'function' ||
      wrongDeclaration.body[0]?.kind !== 'forIn'
    ) {
      throw new Error('Expected for-in statements');
    }
    delete (missingDeclaration.body[0].variable as { type?: IrType }).type;
    (wrongDeclaration.body[0].variable as { type: IrType }).type = { kind: 'primitive', name: 'number' };

    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
    for (const module of [missing, wrong]) {
      expect(validateIrModuleStructure(module)).toMatchObject({
        failures: [
          expect.objectContaining({
            code: 'invalid-node-shape',
            path: expect.stringContaining('.variable.type'),
            reason: 'for-in binding requires primitive string type evidence',
          }),
        ],
        kind: 'invalid',
      });
    }
  });

  it('validates for-in with non-property members in getIrExpressionStaticForInKeys', () => {
    const valid = lower(
      'for-in-spread.ts',
      'export function scan(source: { a: number }): string { const obj = { ...source }; for (const key in obj) return key; return ""; }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });
  });

  it('validates control-flow label identity and uniqueness', () => {
    const valid = lower(
      'labeled-loop.ts',
      'export function scan(): void { outer: for (let i = 0; i < 1; i++) { break outer; } }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const declaration = valid.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const forStatement = declaration.body[0];
    if (forStatement?.kind !== 'for' || !forStatement.label) throw new Error('Expected labeled for');

    const emptyId = structuredClone(valid);
    const emptyIdDeclaration = emptyId.declarations[0];
    if (emptyIdDeclaration?.kind !== 'function') throw new Error('Expected function');
    const emptyIdFor = emptyIdDeclaration.body[0];
    if (emptyIdFor?.kind !== 'for' || !emptyIdFor.label) throw new Error('Expected labeled for');
    (emptyIdFor.label as { id: string }).id = '';

    const emptyName = structuredClone(valid);
    const emptyNameDeclaration = emptyName.declarations[0];
    if (emptyNameDeclaration?.kind !== 'function') throw new Error('Expected function');
    const emptyNameFor = emptyNameDeclaration.body[0];
    if (emptyNameFor?.kind !== 'for' || !emptyNameFor.label) throw new Error('Expected labeled for');
    (emptyNameFor.label as { name: string }).name = '';

    for (const module of [emptyId, emptyName]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('rejects non-discriminated type evidence', () => {
    const module = lower('type-evidence.ts', 'export function identity(value: number): number { return value; }');
    const invalid = structuredClone(module);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    (declaration.parameters[0] as { type: unknown }).type = 'not-a-type-object';

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('validates object type property names, optional flags, and readonly flags', () => {
    const typeModule = lower('object-type.ts', 'export type Shape = { value: number; label: string };');
    const typeDeclaration = typeModule.declarations[0];
    if (typeDeclaration?.kind !== 'typeAlias' || typeDeclaration.type.kind !== 'object') {
      throw new Error('Expected object type alias');
    }
    const property = typeDeclaration.type.properties[0]!;

    const emptyName = structuredClone(typeModule);
    const emptyDecl = emptyName.declarations[0];
    if (emptyDecl?.kind !== 'typeAlias' || emptyDecl.type.kind !== 'object') throw new Error('Expected object type');
    (emptyDecl.type.properties[0] as { name: string }).name = '';

    const nonBoolOptional = structuredClone(typeModule);
    const optDecl = nonBoolOptional.declarations[0];
    if (optDecl?.kind !== 'typeAlias' || optDecl.type.kind !== 'object') throw new Error('Expected object type');
    (optDecl.type.properties[0] as { optional: unknown }).optional = 'true';

    const nonBoolReadonly = structuredClone(typeModule);
    const roDecl = nonBoolReadonly.declarations[0];
    if (roDecl?.kind !== 'typeAlias' || roDecl.type.kind !== 'object') throw new Error('Expected object type');
    (roDecl.type.properties[0] as { readonly: unknown }).readonly = 'true';

    for (const module of [emptyName, nonBoolOptional, nonBoolReadonly]) {
      const result = validateIrModuleStructure(module);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });

  it('validates object binding pattern scope', () => {
    const module = lower(
      'object-binding-scope.ts',
      'export function read(source: { value: number }): number { const { value } = source; return value; }',
    );
    expect(validateIrModuleStructure(module)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(module);
    const declaration = invalid.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function');
    const variable = declaration.body[0];
    if (variable?.kind !== 'variable') throw new Error('Expected variable');
    const destructured = variable.declarations[0];
    if (!destructured || !('pattern' in destructured) || destructured.pattern.kind !== 'object') {
      throw new Error('Expected object binding pattern');
    }
    (destructured.pattern as { scope: string }).scope = 'module';

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-binding-introduction');
    }
  });

  it('validates optional-chain receiver nullish coherence across type kinds', () => {
    const nullReceiver = lower(
      'optional-chain-null.ts',
      'export function read(value: null): undefined { return value?.toString(); }',
    );
    expect(validateIrModuleStructure(nullReceiver)).toEqual({ kind: 'valid' });

    const arrayReceiver = lower(
      'optional-chain-array.ts',
      'export function read(value?: number[]): number | undefined { return value?.[0]; }',
    );
    expect(validateIrModuleStructure(arrayReceiver)).toEqual({ kind: 'valid' });

    const getChainExpression = (module: IrModule) => {
      const declaration = module.declarations[0];
      if (declaration?.kind !== 'function') throw new Error('Expected function');
      const stmt = declaration.body[0];
      if (stmt?.kind !== 'return' || stmt.expression?.kind !== 'element') throw new Error('Expected element');
      return stmt.expression;
    };

    const concreteTypes: Array<Readonly<{ label: string; receiverType: unknown }>> = [
      { label: 'array', receiverType: { element: { kind: 'primitive', name: 'number' }, kind: 'array' } },
      {
        label: 'function',
        receiverType: {
          kind: 'function',
          parameters: [],
          rest: false,
          returns: { kind: 'primitive', name: 'void' },
          thisMode: 'lexical',
          typeParameters: [],
        },
      },
      { label: 'literal', receiverType: { kind: 'literal', value: 42 } },
      { label: 'never', receiverType: { kind: 'never' } },
      { label: 'object', receiverType: { kind: 'object', properties: [] } },
      { label: 'primitive', receiverType: { kind: 'primitive', name: 'number' } },
      { label: 'tuple', receiverType: { elements: [], kind: 'tuple' } },
    ];
    for (const { label, receiverType } of concreteTypes) {
      const variant = structuredClone(arrayReceiver);
      const expr = getChainExpression(variant);
      const chain = expr.semantics.optionalChain;
      if (!chain) throw new Error('Expected optional chain');
      (chain as { receiverType: unknown }).receiverType = receiverType;
      (chain as { receiverNullish: string }).receiverNullish = 'possible';
      expect(validateIrModuleStructure(variant), label).toMatchObject({
        failures: [expect.objectContaining({ path: expect.stringContaining('.optionalChain') })],
        kind: 'invalid',
      });
    }

    const unionWithoutNull = structuredClone(arrayReceiver);
    const unionExpr = getChainExpression(unionWithoutNull);
    const unionChain = unionExpr.semantics.optionalChain;
    if (!unionChain) throw new Error('Expected optional chain');
    (unionChain as { receiverType: unknown }).receiverType = {
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
      ],
    };
    expect(validateIrModuleStructure(unionWithoutNull)).toEqual({ kind: 'valid' });
  });

  it('validates provided default-parameter evidence types when evidence is structurally valid', () => {
    const valid = lower(
      'classified-default.ts',
      'function choose(value: number | null = 1): number | null { return value; } export function read(): number | null { return choose(null); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'call' || !expression.semantics.defaultParameters?.provided[0]) {
      throw new Error('Expected classified default call');
    }
    (expression.semantics.defaultParameters.provided[0] as { argumentType: unknown }).argumentType = 'not-a-type';

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('validates provided optional-parameter evidence types when evidence is structurally valid', () => {
    const valid = lower(
      'classified-optional.ts',
      'function choose(value?: number | null): number | null | undefined { return value; } export function read(): number | null | undefined { return choose(null); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'call' || !expression.semantics.optionalParameters?.provided[0]) {
      throw new Error('Expected classified optional call');
    }
    (expression.semantics.optionalParameters.provided[0] as { argumentType: unknown }).argumentType = 'not-a-type';

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('validates overload implementation parameter count against optional parameter count', () => {
    const valid = lower(
      'overload-optional.ts',
      'function choose(value: number): number; function choose(value: number, extra?: number): number; function choose(value: number, extra?: number): number { return value; } export function read(): number { return choose(1); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'call' || !expression.semantics.overloadImplementation) {
      throw new Error('Expected overloaded call');
    }
    if (!expression.semantics.optionalParameters) throw new Error('Expected optional parameter evidence');
    (expression.semantics.optionalParameters as { parameterCount: number }).parameterCount = 99;

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('rejects optional-parameter evidence with non-array provided field', () => {
    const valid = lower(
      'optional-non-array.ts',
      'function choose(value?: number): number | undefined { return value; } export function read(): number | undefined { return choose(); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const invalid = structuredClone(valid);
    const declaration = invalid.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'call' || !expression.semantics.optionalParameters) {
      throw new Error('Expected optional call');
    }
    (expression.semantics.optionalParameters as { provided: unknown }).provided = 'not-an-array';

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('rejects tuple spread result type with rest element', () => {
    const valid = lower(
      'tuple-rest-type.ts',
      "type Pair = [number, string]; const pair: Pair = [1, 'flight']; export const value: [boolean, number, string] = [true, ...pair];",
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const declaration = valid.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (declaration?.kind !== 'variable' || declaration.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread variable');
    }

    const invalid = structuredClone(valid);
    const invalidDecl = invalid.declarations.find(
      (item) => item.kind === 'variable' && 'binding' in item && item.binding.name === 'value',
    );
    if (invalidDecl?.kind !== 'variable' || invalidDecl.initializer?.kind !== 'tupleSpread') {
      throw new Error('Expected tuple spread');
    }
    (invalidDecl.initializer as unknown as { type: { elements: unknown[] } }).type.elements = [
      { optional: false, rest: true, type: { kind: 'primitive', name: 'number' } },
    ];

    const result = validateIrModuleStructure(invalid);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
    }
  });

  it('validates individual optional-parameter evidence conditions', () => {
    const valid = lower(
      'optional-conditions.ts',
      'function choose(value?: number | null): number | null | undefined { return value; } export function read(): number | null | undefined { return choose(null); }',
    );
    expect(validateIrModuleStructure(valid)).toEqual({ kind: 'valid' });

    const declaration = valid.declarations.find(
      (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;
    if (expression?.kind !== 'call' || !expression.semantics.optionalParameters) {
      throw new Error('Expected optional call');
    }
    const base = expression.semantics.optionalParameters;

    const replacements = [
      { ...base, optional: [0], provided: [{ ...base.provided[0], position: 0, value: 'invalid' }] },
      { ...base, optional: [0], provided: [{ ...base.provided[0], argumentType: 'bad', position: 0 }] },
      { ...base, optional: [0], provided: [{ ...base.provided[0], parameterType: 'bad', position: 0 }] },
    ];
    for (const replacement of replacements) {
      const invalid = structuredClone(valid);
      const decl = invalid.declarations.find(
        (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
      );
      const stmt = decl?.kind === 'function' ? decl.body[0] : undefined;
      const expr = stmt?.kind === 'return' ? stmt.expression : undefined;
      if (expr?.kind !== 'call') throw new Error('Expected optional call');
      (expr.semantics as { optionalParameters: unknown }).optionalParameters = replacement;

      const result = validateIrModuleStructure(invalid);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.failures.map((failure) => failure.code)).toContain('invalid-node-shape');
      }
    }
  });
});

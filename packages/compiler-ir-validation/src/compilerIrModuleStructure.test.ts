import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerIrModuleValidationFailureCode,
  IrArrayBindingPattern,
  IrBindingIdentity,
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

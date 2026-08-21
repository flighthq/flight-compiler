import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerIrModuleValidationFailureCode, IrModule } from '../../compiler-types/src/index.js';
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

  it('reports stable identity, origin, reference, cardinality, arity, kind, and shape failures', () => {
    const module = lower('identity.ts', 'export function identity<T>(value: T): T { return value; }');
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const parameter = declaration.parameters[0]!;
    const returned = declaration.body[0];
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'identifier') {
      throw new Error('Expected returned identifier');
    }
    if (returned.expression.reference.kind !== 'binding') throw new Error('Expected binding reference');
    const bindingReference = returned.expression.reference;
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
    const malformed: readonly [IrModule, CompilerIrModuleValidationFailureCode][] = [
      [{ ...module, name: '' }, 'invalid-module-identity'],
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
      [{ ...module, declarations: [declaration, declaration] }, 'duplicate-binding-identity'],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  ...returned,
                  expression: {
                    ...returned.expression,
                    reference: { ...bindingReference, binding: { ...bindingReference.binding, id: 'missing' } },
                  },
                },
              ],
            },
          ],
        },
        'dangling-binding-reference',
      ],
      [
        {
          ...module,
          declarations: [
            {
              ...declaration,
              body: [
                {
                  ...returned,
                  expression: {
                    ...returned.expression,
                    reference: {
                      ...bindingReference,
                      binding: { ...bindingReference.binding, scope: 'module' },
                    },
                  },
                },
              ],
            },
          ],
        },
        'inconsistent-binding-reference',
      ],
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

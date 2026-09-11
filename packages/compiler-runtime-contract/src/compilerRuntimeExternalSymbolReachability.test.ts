import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { collectIrModulesRuntimeExternalSymbolIdentities } from './compilerRuntimeExternalSymbolReachability.js';

describe('collectIrModulesRuntimeExternalSymbolIdentities', () => {
  it('collects ambient external symbols through declaration, type, statement, and expression containers', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/runtime/src/contracts.ts',
      `
        export type ExternalMap<T extends PromiseLike<number> = Set<string>> =
          Readonly<Map<string, T & Float32Array>>;
        export type ExternalIndexed = ExternalShape['value'];
        export type ExternalProjection<T extends Error> = Omit<Pick<T, keyof T>, 'stack'>;
        export type ExternalObject = {
          callback: <T extends Error = Error>(value: T) => Promise<T>;
          value: 'literal' | 1 | true | null | undefined | never;
        };
        export type ExternalQuery = typeof Promise;
        export interface ExternalShape extends Iterable<Uint8Array> {
          value?: Required<Array<Int16Array>>;
        }
        export enum ExternalChoice { first }
        export class ExternalError extends Error {}
        export class ExternalBox<T extends Error = Error> implements ExternalShape {
          field: Promise<T> = Promise.resolve(new Error());
          constructor(input: ArrayBuffer);
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
        export function choose(
          callback: (value: BigInt64Array) => BigUint64Array,
          tuple: [DataView, RegExp?],
        ): keyof ExternalShape | Date {
          callback(new BigInt64Array());
          return true ? new Date() : ({} as Date);
        }
        export async function containers(values: number[]): Promise<number> {
          let total: number = [1, , 2][0]!;
          const [selected = new URL('https://example.test')] = [];
          selected;
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
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const lowered = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/runtime',
      upstreamDirectory: '/flight',
    });
    const snapshot = structuredClone(lowered.module);

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'Array', space: 'value' },
      { sourceName: 'ArrayBuffer', space: 'type' },
      { sourceName: 'BigInt64Array', space: 'type' },
      { sourceName: 'BigInt64Array', space: 'value' },
      { sourceName: 'BigUint64Array', space: 'type' },
      { sourceName: 'DataView', space: 'type' },
      { sourceName: 'Date', space: 'type' },
      { sourceName: 'Date', space: 'value' },
      { sourceName: 'Error', space: 'type' },
      { sourceName: 'Error', space: 'value' },
      { sourceName: 'Float32Array', space: 'type' },
      { sourceName: 'Float64Array', space: 'type' },
      { sourceName: 'Int16Array', space: 'type' },
      { sourceName: 'Int32Array', space: 'type' },
      { sourceName: 'Iterable', space: 'type' },
      { sourceName: 'Map', space: 'type' },
      { sourceName: 'Promise', space: 'type' },
      { sourceName: 'Promise', space: 'value' },
      { sourceName: 'PromiseLike', space: 'type' },
      { sourceName: 'Record', space: 'type' },
      { sourceName: 'RegExp', space: 'type' },
      { sourceName: 'Set', space: 'type' },
      { sourceName: 'URL', space: 'value' },
      { sourceName: 'Uint16Array', space: 'type' },
      { sourceName: 'Uint32Array', space: 'type' },
      { sourceName: 'Uint8Array', space: 'type' },
      { sourceName: 'WeakMap', space: 'type' },
    ]);
    expect(lowered.module).toEqual(snapshot);
  });

  it('deduplicates and canonically orders identities across modules', () => {
    const first = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/first.ts',
        'export type First = Promise<Zed> | E\u0301xternal;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;
    const second = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/second.ts',
        'export type Second = Promise<Alpha> | \u00c9xternal;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;

    expect(collectIrModulesRuntimeExternalSymbolIdentities([second, first])).toEqual([
      { sourceName: 'Alpha', space: 'type' },
      { sourceName: 'Promise', space: 'type' },
      { sourceName: 'Zed', space: 'type' },
      { sourceName: '\u00c9xternal', space: 'type' },
    ]);
    expect(collectIrModulesRuntimeExternalSymbolIdentities([first, second])).toEqual(
      collectIrModulesRuntimeExternalSymbolIdentities([second, first]),
    );
  });

  it('returns an empty identity set for modules without ambient named types', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/empty.ts',
        'export type Scalar = string | number; export const value: Scalar = 1;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([])).toEqual([]);
    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([]);
  });

  it('treats PropertyKey as a closed compiler-intrinsic type', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/property-key.ts',
        'export type PropertyBag = Record<PropertyKey, unknown>;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'Record', space: 'type' },
    ]);
  });

  it('collects utility storage subjects without erased key and constraint arguments', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/utilities.ts',
        `
          export type UtilityStorage =
            | Exclude<StoredUnion, typeof ErasedKey>
            | Extract<ExtractedUnion, ErasedConstraint>
            | NonNullable<PresentStorage>
            | NoInfer<InferredStorage>
            | Omit<OmittedStorage, 'key'>
            | Pick<PickedStorage, 'key'>;
        `,
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'ExtractedUnion', space: 'type' },
      { sourceName: 'InferredStorage', space: 'type' },
      { sourceName: 'OmittedStorage', space: 'type' },
      { sourceName: 'PickedStorage', space: 'type' },
      { sourceName: 'PresentStorage', space: 'type' },
      { sourceName: 'StoredUnion', space: 'type' },
    ]);
  });

  it('fails defensively for forged declaration, expression, member, statement, and type kinds', () => {
    const empty = lowerTypeScriptSource(
      ts.createSourceFile('/flight/packages/runtime/src/base.ts', '', ts.ScriptTarget.Latest, true),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;
    const functionModule = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/function.ts',
        'export function read(): void {}',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;
    const typeModule = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/type.ts',
        'export type Value = string;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;
    const functionDeclaration = functionModule.declarations[0]!;
    const typeDeclaration = typeModule.declarations[0]!;
    const invalidKind = { kind: 'invalid' };
    const malformedModules = [
      { ...empty, declarations: [invalidKind] },
      { ...empty, exports: [{ expression: invalidKind, kind: 'default' }] },
      {
        ...empty,
        exports: [
          {
            expression: { kind: 'object', members: [invalidKind], type: { kind: 'unknown', source: 'object' } },
            kind: 'default',
          },
        ],
      },
      { ...functionModule, declarations: [{ ...functionDeclaration, body: [invalidKind] }] },
      { ...typeModule, declarations: [{ ...typeDeclaration, type: invalidKind }] },
    ] as unknown as readonly IrModule[];

    for (const malformed of malformedModules) {
      expect(() => collectIrModulesRuntimeExternalSymbolIdentities([malformed])).toThrow(
        'Unknown IR traversal kind invalid',
      );
    }
  });

  it('collects constructor, static, typeof, and direct ambient values without confusing bound names or intrinsics', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/values.ts',
        `
          const Map = (): number => 1;
          export function use(): typeof Promise {
            Map();
            Math.max(1, 2);
            Promise.resolve(1);
            new Date();
            undefined;
            return Promise;
          }
        `,
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'Date', space: 'value' },
      { sourceName: 'Math', space: 'value' },
      { sourceName: 'Promise', space: 'value' },
    ]);
  });

  it('collects an ambient value referenced only from a type query', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/query.ts',
        'export type Factory = typeof Promise;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'Promise', space: 'value' },
    ]);
  });

  it('collects external types carried only by target-neutral semantic evidence', () => {
    const module = lowerTypeScriptSource(
      ts.createSourceFile('/flight/packages/runtime/src/evidence.ts', '', ts.ScriptTarget.Latest, true),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    ).module;
    const named = (name: string) => ({
      kind: 'named' as const,
      reference: { kind: 'ambient' as const, name },
      typeArguments: [],
    });
    const evidence = {
      ...module,
      exports: [
        {
          expression: {
            arguments: [{ kind: 'literal', value: 1 }],
            callee: { kind: 'identifier', reference: { kind: 'ambient', name: 'invoke' } },
            kind: 'call',
            optional: true,
            semantics: {
              optionalChain: {
                receiverEvaluation: 'once',
                receiverNullish: 'possible',
                receiverType: named('SemanticReceiver'),
                result: 'undefined',
                shortCircuit: 'nullish',
                valueType: named('SemanticValue'),
              },
              optionalParameters: {
                omitted: [],
                optional: [0],
                parameterCount: 1,
                provided: [
                  {
                    argumentType: named('SemanticArgument'),
                    parameterType: named('SemanticParameter'),
                    position: 0,
                    value: 'value',
                  },
                ],
                providedArgumentCount: 1,
              },
              resultType: named('SemanticResult'),
              signature: { parameterCount: 1, providedArgumentCount: 1 },
            },
            typeArguments: [],
          },
          kind: 'default',
        },
      ],
    } as const satisfies IrModule;

    expect(collectIrModulesRuntimeExternalSymbolIdentities([evidence])).toEqual([
      { sourceName: 'SemanticArgument', space: 'type' },
      { sourceName: 'SemanticParameter', space: 'type' },
      { sourceName: 'SemanticReceiver', space: 'type' },
      { sourceName: 'SemanticResult', space: 'type' },
      { sourceName: 'SemanticValue', space: 'type' },
      { sourceName: 'invoke', space: 'value' },
    ]);
  });
});

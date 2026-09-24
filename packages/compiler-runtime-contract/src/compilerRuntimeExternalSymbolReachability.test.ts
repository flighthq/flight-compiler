import ts from 'typescript';

import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
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

  it('does not elect instantiated ambient method type parameters while retaining the concrete iterator view', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/runtime/src/ambient-methods.ts',
      `export function visit<T>(items: T[], values: Map<string, T>): void {
         for (const item of Object.values(items)) void item;
         for (const value of values.values()) void value;
         items.flat(1);
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const [lowered] = lowerTypeScriptSources([
      { packageName: '@flighthq/runtime', sourceFile, upstreamDirectory: '/flight' },
    ]);

    expect(lowered!.diagnostics).toEqual([]);
    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered!.module])).toEqual([
      { sourceName: 'Map', space: 'type' },
      { sourceName: 'MapIterator', space: 'type' },
      { sourceName: 'Object', space: 'value' },
    ]);
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

  it('treats Awaited and ThisType as compiler-intrinsic wrappers while retaining their storage', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/intrinsic-wrappers.ts',
        'export type IntrinsicViews = Awaited<Promise<Storage>> | ThisType<Context>;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'Context', space: 'type' },
      { sourceName: 'Promise', space: 'type' },
      { sourceName: 'Storage', space: 'type' },
    ]);
  });

  it('treats unresolved callable projection wrappers as intrinsic while retaining their operands', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/callable-utilities.ts',
        `
          export type ProjectedReturn = ReturnType<() => ReturnStorage>;
          export type ProjectedParameters = Parameters<(value: ParameterStorage) => void>;
          export type AmbientReturn = ReturnType<typeof externalCall>;
          export type RuntimeViews = ArrayLike<ArrayStorage> | ArrayBufferLike;
        `,
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'ArrayBufferLike', space: 'type' },
      { sourceName: 'ArrayLike', space: 'type' },
      { sourceName: 'ArrayStorage', space: 'type' },
      { sourceName: 'ParameterStorage', space: 'type' },
      { sourceName: 'ReturnStorage', space: 'type' },
      { sourceName: 'externalCall', space: 'value' },
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
      { sourceName: 'Promise', space: 'type' },
      { sourceName: 'Promise', space: 'value' },
    ]);
  });

  it('does not treat a typeof probe as a use of the probed ambient global', () => {
    const lowered = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/runtime/src/presence.ts',
        `
          export function present(): boolean {
            return typeof SharedArrayBuffer !== 'undefined';
          }
          export function read(): string {
            return document.title;
          }
          export function nested(): string {
            return typeof window.location.href;
          }
        `,
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
    );

    // `typeof SharedArrayBuffer` is a presence query and claims nothing. A nested operand still
    // evaluates its receiver, so `typeof window.location.href` remains a use of `window`.
    expect(collectIrModulesRuntimeExternalSymbolIdentities([lowered.module])).toEqual([
      { sourceName: 'document', space: 'value' },
      { sourceName: 'window', space: 'value' },
    ]);
  });

  it('does not invent shared-memory reachability for a bare typed-array subarray result', () => {
    const lower = (file: string, source: string) =>
      lowerTypeScriptSource(
        ts.createSourceFile(`/flight/packages/runtime/src/${file}`, source, ts.ScriptTarget.Latest, true),
        { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
      );
    const bare = lower(
      'typed-array-subarray.ts',
      'export function view(bytes: Uint8Array): Uint8Array { return bytes.subarray(1); }',
    );
    const shared = lower(
      'shared-typed-array-subarray.ts',
      'export function view(bytes: Uint8Array<SharedArrayBuffer>): Uint8Array<SharedArrayBuffer> { return bytes.subarray(1); }',
    );

    expect(bare.diagnostics).toEqual([]);
    expect(collectIrModulesRuntimeExternalSymbolIdentities([bare.module])).toEqual([
      { sourceName: 'Uint8Array', space: 'type' },
    ]);
    expect(shared.diagnostics).toEqual([]);
    expect(collectIrModulesRuntimeExternalSymbolIdentities([shared.module])).toEqual([
      { sourceName: 'SharedArrayBuffer', space: 'type' },
      { sourceName: 'Uint8Array', space: 'type' },
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
      { sourceName: 'invoke', space: 'value' },
    ]);
  });
});

describe('collectIrModulesRuntimeExternalSymbolIdentities type parameters', () => {
  // A call to an IMPORTED generic function, and the standard-library operations that carry an external
  // parameter into the result: `Array<T>.pop` returns `T | undefined` and `Map<K, V>.get` returns
  // `V | undefined`, with `T` and `V` declared in the libraries rather than in any analyzed module.
  // Those declarations live outside the module set, which is the test that decided the ambient branch,
  // so each parameter was lowered as an ambient reference named after itself and entered the plan as
  // though a global type `T` or `V` had to exist. A type parameter is a compiler generic, and what says
  // so is its declaration kind rather than where the declaration happens to live.
  const provider = `
    export function identity<X>(value: X): X { return value; }
    export interface Box<Y> { readonly items: Y[]; }
    export const table = new Map<string, number>();
  `;
  const consumer = `
    import { identity, table } from '@flighthq/app/provider';
    import type { Box } from '@flighthq/app/provider';

    export type IdentityResult = ReturnType<typeof identity>;
    export type IdentityParameters = Parameters<typeof identity>;
    export function identityOf(value: string): IdentityResult { return identity(value); }
    export function identityWith(value: string): IdentityParameters { return [value]; }

    export function firstOf<Z>(box: Box<Z>): Z | undefined { const items = box.items; return items.pop(); }
    export function lookUp(key: string): number | undefined { return table.get(key); }
    export function optionOf<Z>(box: Box<Z>): Z | undefined { const items = box.items; return items[0]; }
    export function callbackOf<Z>(box: Box<Z>): () => Z | undefined {
      const items = box.items;
      return () => items.pop();
    }
  `;

  function lowerBoth() {
    const providerFile = ts.createSourceFile(
      '/flight/packages/app/src/provider.ts',
      provider,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumerFile = ts.createSourceFile(
      '/flight/packages/app/src/consumer.ts',
      consumer,
      ts.ScriptTarget.Latest,
      true,
    );
    return lowerTypeScriptSources(
      [
        { packageName: '@flighthq/app', sourceFile: providerFile, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/app', sourceFile: consumerFile, upstreamDirectory: '/flight' },
      ],
      {
        edges: [
          {
            specifier: '@flighthq/app/provider',
            target: { packageName: '@flighthq/app', source: 'packages/app/src/provider.ts' },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
    ).map((result) => result.module);
  }

  it('never collects a library type parameter as a runtime external symbol', () => {
    const identities = collectIrModulesRuntimeExternalSymbolIdentities(lowerBoth());

    expect(identities.map((identity) => identity.sourceName)).not.toContain('R');
    expect(identities.map((identity) => identity.sourceName)).not.toContain('X');
    expect(identities.map((identity) => identity.sourceName)).not.toContain('V');
    expect(identities.map((identity) => identity.sourceName)).not.toContain('T');
    expect(identities.map((identity) => identity.sourceName)).not.toContain('P');
  });

  // The wrappers are the audit, and `ReturnType` and `Parameters` are the conditional ones: both are
  // declared in the library as `T extends (...args: infer R) => any ? R : never`, so their bodies carry
  // the parameter inside a conditional whose branches are inferred parameters. An array, a map read, a
  // callback return, an index read and a nullish widening carry it too, and every one of them funnels
  // through the same type-reference lowering. A rule that held for one wrapper and not another would be
  // a two-site patch.
  it('holds through arrays, map reads, callbacks, indexed reads and optional widening', () => {
    const ambient = new Set<string>();
    for (const module of lowerBoth()) {
      analyzeIrModuleTraversal(module, {
        type(type) {
          if (type.kind === 'named' && type.reference.kind === 'ambient') ambient.add(type.reference.name);
        },
      });
    }

    expect([...ambient].filter((name) => /^[A-Z]$/u.test(name))).toEqual([]);
    expect([...ambient]).toContain('Map');
  });

  // The counterexample that keeps the rule honest: the fix must not ban a letter. A global the analyzer
  // cannot see is a runtime symbol the plan has to require, whatever it is called, so `T` reaching the
  // plan as an unresolved global is correct and stays. What changed is that a name whose declaration IS
  // a type parameter no longer arrives here at all, because a type parameter is a compiler generic and
  // not a runtime symbol.
  it('still requires a genuine external type that happens to be named with one letter', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/app/src/external.ts',
      `export function use(value: T, other: Widget): void { void value; void other; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const module = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/app',
      upstreamDirectory: '/flight',
    }).module;

    const names = collectIrModulesRuntimeExternalSymbolIdentities([module]).map((identity) => identity.sourceName);
    expect(names).toContain('T');
    expect(names).toContain('Widget');
  });
});

import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { collectIrModulesRuntimeExternalTypeIdentities } from './compilerRuntimeExternalTypeReachability.js';

describe('collectIrModulesRuntimeExternalTypeIdentities', () => {
  it('collects ambient external types through declaration, type, statement, and expression containers', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/runtime/src/contracts.ts',
      `
        export type ExternalMap<T extends PromiseLike<number> = Set<string>> =
          Readonly<Map<string, T & Float32Array>>;
        export type ExternalIndexed = ExternalShape['value'];
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

    expect(collectIrModulesRuntimeExternalTypeIdentities([lowered.module])).toEqual([
      { sourceName: 'BigInt64Array' },
      { sourceName: 'BigUint64Array' },
      { sourceName: 'DataView' },
      { sourceName: 'Date' },
      { sourceName: 'Error' },
      { sourceName: 'Float32Array' },
      { sourceName: 'Float64Array' },
      { sourceName: 'Int16Array' },
      { sourceName: 'Int32Array' },
      { sourceName: 'Iterable' },
      { sourceName: 'Map' },
      { sourceName: 'Promise' },
      { sourceName: 'PromiseLike' },
      { sourceName: 'Record' },
      { sourceName: 'RegExp' },
      { sourceName: 'Set' },
      { sourceName: 'Uint16Array' },
      { sourceName: 'Uint32Array' },
      { sourceName: 'Uint8Array' },
      { sourceName: 'WeakMap' },
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

    expect(collectIrModulesRuntimeExternalTypeIdentities([second, first])).toEqual([
      { sourceName: 'Alpha' },
      { sourceName: 'Promise' },
      { sourceName: 'Zed' },
      { sourceName: '\u00c9xternal' },
    ]);
    expect(collectIrModulesRuntimeExternalTypeIdentities([first, second])).toEqual(
      collectIrModulesRuntimeExternalTypeIdentities([second, first]),
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

    expect(collectIrModulesRuntimeExternalTypeIdentities([])).toEqual([]);
    expect(collectIrModulesRuntimeExternalTypeIdentities([lowered.module])).toEqual([]);
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
        exports: [{ expression: { kind: 'object', members: [invalidKind] }, kind: 'default' }],
      },
      { ...functionModule, declarations: [{ ...functionDeclaration, body: [invalidKind] }] },
      { ...typeModule, declarations: [{ ...typeDeclaration, type: invalidKind }] },
    ] as unknown as readonly IrModule[];

    for (const malformed of malformedModules) {
      expect(() => collectIrModulesRuntimeExternalTypeIdentities([malformed])).toThrow(
        'Unexpected neutral IR kind invalid',
      );
    }
  });
});

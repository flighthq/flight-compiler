import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function lower(source: string) {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
}

function emit(source: string): string {
  const result = lower(source);
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function refusal(source: string) {
  const result = lower(source);
  expect(result.diagnostics).toEqual([]);
  try {
    emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

const callable = 'T extends (...args: any[]) => void';
const forwarded = 'std::forward<ArgsPack>(args)...';

describe('emitIrModuleCpp dependent callable pack reuse', () => {
  it('forwards one expansion outside a loop', () => {
    const contents = emit(`
      export function once<${callable}>(slot: T, ...args: Parameters<T>): void {
        slot(...args);
      }
    `);

    expect(contents).toContain(`slot(${forwarded});`);
  });

  it('forwards one expansion in a branch that executes at most once', () => {
    const contents = emit(`
      export function maybe<${callable}>(slot: T, go: boolean, ...args: Parameters<T>): void {
        if (go) slot(...args);
      }
    `);

    expect(contents).toContain(`slot(${forwarded});`);
  });

  it('passes one ordered generic carrier as lvalues to two calls', () => {
    const contents = emit(`
      export function twice<T extends (first: string, second: number) => void>(
        first: T,
        second: T,
        ...args: Parameters<T>
      ): void {
        first(...args);
        second(...args);
      }
    `);
    const firstCall = contents.indexOf('first(args...);');
    const secondCall = contents.indexOf('second(args...);');

    expect(contents).toContain('requires flight::callable_signature_v1<T>::template accepts<ArgsPack...>');
    expect(firstCall).toBeGreaterThanOrEqual(0);
    expect(secondCall).toBeGreaterThan(firstCall);
    expect(contents.match(/args\.\.\./gu)).toHaveLength(2);
    expect(contents).not.toContain(forwarded);
  });

  it.each([
    ['for body', 'for (let i = 0; i < slots.length; i++) slots[i](...args);'],
    ['for increment', 'for (let i = 0; i < 1; slots[0](...args)) i++;'],
    ['while', 'let i = 0; while (i < slots.length) { slots[i](...args); i++; }'],
    ['do', 'let i = 0; do { slots[i](...args); i++; } while (i < slots.length);'],
    ['for-of', 'for (const slot of slots) slot(...args);'],
    ['for-in', 'for (const key in { first: 1 }) { void key; slots[0](...args); }'],
  ])('passes lvalues to one expansion in a %s', (_, body) => {
    const contents = emit(`
      export function all<${callable}>(slots: T[], ...args: Parameters<T>): void {
        ${body}
      }
    `);

    expect(contents).toContain('(args...);');
    expect(contents).not.toContain(forwarded);
  });

  it.each([
    [
      'an aliased owner projection',
      `type Args<T extends (...values: any[]) => void> = Parameters<T>;
       export function ambiguous<T extends (...values: any[]) => void>(a: T, b: T, ...args: Args<T>): void {
         a(...args);
         b(...args);
       }`,
    ],
    [
      'a generic callable owner',
      `export function incompatible<T extends <U>(value: U) => void>(a: T, b: T, ...args: Parameters<T>): void {
         a(...args);
         b(...args);
       }`,
    ],
  ])('keeps the stable refusal for %s', (_, source) => {
    const error = refusal(source);

    expect(error.code).toBe('unsupported-ir');
    expect(error.message).toContain('Parameters<T> requires a statically resolvable non-generic callable type');
  });
});

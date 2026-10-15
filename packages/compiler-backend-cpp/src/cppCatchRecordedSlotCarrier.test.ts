import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

function compile(source: string): string {
  const lowering = lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/power/src/probe.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/power', upstreamDirectory: '/flight' },
  );
  expect(lowering.diagnostics).toEqual([]);
  const session = createCppCompilerBackend().createEmissionSession!({
    modules: [lowering.module],
    options: {
      packageTargets: {
        '@flighthq/power': { includePrefix: 'flight/power', namespace: 'flight::power' },
      },
      runtimeProfile: 'flight-cpp',
    },
  });
  return session.emitModule(lowering.module)[0]!.contents;
}

function captureRefusal(source: string) {
  try {
    compile(source);
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

const attemptAll = (sentinel: 'null' | 'undefined') => `
  export function teardown(values: readonly number[]): void {
    let failure: unknown = ${sentinel};
    for (const value of values) {
      try {
        if (value > 1) throw new Error('too big');
      } catch (error) {
        failure ??= error;
        continue;
      }
    }
    if (failure !== ${sentinel}) throw failure;
  }`;

describe('C++ catch-recorded exception slot carrier', () => {
  it.each(['null', 'undefined'] as const)(
    'uses one empty exception pointer for a %s-initialized slot and rethrows the original',
    (sentinel) => {
      const contents = compile(attemptAll(sentinel));

      expect(contents).toContain('std::exception_ptr failure = nullptr;');
      expect(contents).not.toContain('flight::Any failure');
      expect(contents).toContain('catch (const std::exception& error)');
      expect(contents).toContain('if (!failure) failure = std::current_exception();');
      expect(contents.match(/std::current_exception\(\)/gu)).toHaveLength(1);
      expect(contents).toContain('return presence_operand;');
      expect(contents).toContain('std::rethrow_exception(failure);');
    },
  );

  it('leaves an ordinary unknown slot on the dynamic-value carrier', () => {
    const contents = compile(`
      export function note(): unknown {
        let note: unknown = null;
        note ??= 'text';
        return note;
      }`);

    expect(contents).toContain('flight::Any note = nullptr;');
    expect(contents).not.toContain('exception_ptr');
  });

  it('uses pointer presence for a loose test that intentionally merges null and undefined', () => {
    const contents = compile(`
      export function teardown(): void {
        let failure: unknown = null;
        try { throw new Error('too big'); }
        catch (error) { failure ??= error; }
        if (failure != undefined) throw failure;
      }`);

    expect(contents).toContain('std::exception_ptr failure = nullptr;');
    expect(contents).toContain('return presence_operand;');
  });

  it('refuses a strict test against the other sentinel instead of merging their meanings', () => {
    const refusal = captureRefusal(`
      export function teardown(): void {
        let failure: unknown = null;
        try { throw new Error('too big'); }
        catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
  });

  it('refuses a caught value recorded into a slot that is never rethrown', () => {
    const refusal = captureRefusal(`
      export function record(values: readonly number[]): unknown {
        let failure: unknown = null;
        for (const value of values) {
          try { if (value > 1) throw new Error('too big'); }
          catch (error) { failure ??= error; }
        }
        return failure;
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
    expect(refusal.message).toContain('cannot be recorded in erased flight::Any storage');
  });

  it('refuses a caught value when the slot is also read as a value', () => {
    const refusal = captureRefusal(`
      export function record(values: readonly number[]): void {
        let failure: unknown = null;
        for (const value of values) {
          try { if (value > 1) throw new Error('too big'); }
          catch (error) { failure ??= error; }
        }
        const observed = failure;
        if (observed === null) return;
        throw failure;
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
  });

  it('refuses a caught value recorded through a non-local owner', () => {
    const refusal = captureRefusal(`
      interface State { failure: unknown }
      export function record(state: State): void {
        try { throw new Error('too big'); }
        catch (error) { state.failure ??= error; }
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
  });
});

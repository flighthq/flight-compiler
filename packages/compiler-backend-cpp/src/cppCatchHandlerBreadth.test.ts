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

const attemptAll = `
  export function teardown(values: readonly number[]): void {
    let failure: unknown = null;
    for (const value of values) {
      try {
        if (value > 1) throw new Error('too big');
      } catch (error) {
        failure ??= error;
        continue;
      }
    }
    if (failure !== null) throw failure;
  }`;

describe('C++ reify-only catch handler breadth', () => {
  it('catches every thrown value while retaining and rethrowing the first original failure', () => {
    const contents = compile(attemptAll);

    expect(contents).toContain('catch (...) {');
    expect(contents).not.toContain('const std::exception& error');
    expect(contents).toContain('if (!failure) failure = std::current_exception();');
    expect(contents.match(/std::current_exception\(\)/gu)).toHaveLength(1);
    expect(contents).toContain('std::rethrow_exception(failure);');
  });

  it('keeps the narrow handler when the caught value is directly rethrown', () => {
    const contents = compile(`
      export function rethrow(value: number): void {
        try { if (value > 1) throw new Error('too big'); }
        catch (error) { throw error; }
      }`);

    expect(contents).toContain('catch (const std::exception& error) {');
    expect(contents).not.toContain('catch (...) {');
  });

  it('keeps a binding-less catch-all unchanged', () => {
    const contents = compile(`
      export function ignore(value: number): void {
        try { if (value > 1) throw new Error('too big'); }
        catch { return; }
      }`);

    expect(contents).toContain('catch (...) {');
    expect(contents).not.toContain('const std::exception&');
  });

  it('does not bypass the refusal for a caught value recorded in a non-exception slot', () => {
    const refusal = captureRefusal(`
      export function note(value: number): unknown {
        let observed: unknown = null;
        try { if (value > 1) throw new Error('too big'); }
        catch (error) { observed = error; }
        return observed;
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
  });

  it('does not widen a handler whose slot is not part of a record-and-rethrow pattern', () => {
    const refusal = captureRefusal(`
      export function note(value: number): unknown {
        let observed: unknown = null;
        try { if (value > 1) throw new Error('too big'); }
        catch (error) { observed ??= error; }
        return observed;
      }`);

    expect(refusal.rule).toBe('cpp-catch-recording-slot-carrier-unrepresented');
  });
});

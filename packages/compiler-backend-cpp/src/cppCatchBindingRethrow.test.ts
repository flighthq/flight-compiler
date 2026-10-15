import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

function compile(source: string): string {
  const lowering = lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/physics2d/src/probe.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/physics2d', upstreamDirectory: '/flight' },
  );
  expect(lowering.diagnostics).toEqual([]);
  const session = createCppCompilerBackend().createEmissionSession!({
    modules: [lowering.module],
    options: {
      packageTargets: {
        '@flighthq/physics2d': { includePrefix: 'flight/physics2d', namespace: 'flight::physics2d' },
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

describe('C++ catch binding rethrow', () => {
  it('rethrows the active exception without copying its static base type', () => {
    const contents = compile(`
      interface Box { value: number }
      export function guarded(box: Box, hook: (box: Box) => void): void {
        const saved = box.value;
        try { hook(box); }
        catch (error) { box.value = saved; throw error; }
      }`);

    expect(contents).toContain('catch (...) {');
    expect(contents).toContain('throw;');
    expect(contents).not.toContain('throw error;');
    expect(contents).not.toContain('std::current_exception()');
  });

  it('declares each observed binding with the same allocated name its uses read', () => {
    const contents = compile(`
      export function guardedTwice(
        first: () => void,
        second: () => void,
        inspect: (value: unknown) => void,
      ): void {
        try { first(); }
        catch (error) { inspect(error); throw error; }
        try { second(); }
        catch (error) { inspect(error); throw error; }
      }`);
    const handlers = [
      ...contents.matchAll(/catch \(const std::exception& (\w+)\) \{\n\s*inspect\((\w+)\);\n\s*throw;/gu),
    ];

    expect(handlers).toHaveLength(2);
    expect(handlers.map((handler) => handler[1])).toEqual(handlers.map((handler) => handler[2]));
    expect(handlers[0]?.[1]).not.toBe(handlers[1]?.[1]);
    expect(contents).not.toContain('throw error;');
  });

  it('keeps two direct rethrows independent without naming either catch binding', () => {
    const contents = compile(`
      export function guardedTwice(first: () => void, second: () => void): void {
        try { first(); } catch (error) { throw error; }
        try { second(); } catch (error) { throw error; }
      }`);

    expect(contents.match(/catch \(\.\.\.\)/gu)).toHaveLength(2);
    expect(contents.match(/throw;/gu)).toHaveLength(2);
    expect(contents).not.toContain('throw error');
    expect(contents).not.toContain('error_2');
  });

  it('captures once when the same handler records and directly rethrows its exception', () => {
    const contents = compile(`
      export function recordAndRethrow(hook: () => void): void {
        let failure: unknown = null;
        try { hook(); }
        catch (error) { failure ??= error; throw error; }
        if (failure !== null) throw failure;
      }`);

    expect(contents).toContain('catch (...) {');
    expect(contents).toContain('if (!failure) failure = std::current_exception();');
    expect(contents.match(/std::current_exception\(\)/gu)).toHaveLength(1);
    expect(contents).toContain('throw;');
    expect(contents).toContain('std::rethrow_exception(failure);');
  });

  it('does not turn an outer binding throw inside a nested handler into a rethrow of the inner exception', () => {
    const contents = compile(`
      export function guarded(first: () => void, second: () => void): void {
        try { first(); }
        catch (outer) {
          try { second(); }
          catch { throw outer; }
        }
      }`);

    expect(contents).toContain('catch (const std::exception& outer) {');
    expect(contents).toContain('throw outer;');
  });

  it('does not emit a bare rethrow inside a closure that can outlive its handler', () => {
    const contents = compile(`
      export function guarded(hook: () => void): () => void {
        try { hook(); }
        catch (error) { return () => { throw error; }; }
        return () => {};
      }`);

    expect(contents).toContain('catch (const std::exception& error) {');
    expect(contents).toContain('throw error;');
  });

  it('keeps a rethrow after suspension behind the owned-carrier refusal', () => {
    const refusal = captureRefusal(`
      export async function guarded(task: Promise<void>, pause: Promise<void>): Promise<void> {
        try { await task; }
        catch (error) { await pause; throw error; }
      }`);

    expect(refusal.rule).toBe('cpp-lowering-pass-refused');
    expect(refusal.classification).toBe('compiler-restriction');
    expect(refusal.message).toContain('owned exception-value lowering');
    expect(refusal.message).not.toContain('owned caught-value carrier');
  });
});

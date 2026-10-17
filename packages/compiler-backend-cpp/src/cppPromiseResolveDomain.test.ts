import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';

// The runtime resolver deduces its task type from the value it is handed, so a literal whose own domain is
// narrower than the declaration's would settle the narrower task -- `Task<flight::Undefined>` where the
// function declares `Task<flight::Any>` -- and the `return` then has no conversion. The declared domain is
// what the settlement must carry, so the resolver is given it explicitly, exactly as a source-written
// `Promise.resolve<T>(x)` already is.
//
// The measured site is `@flighthq/loader`'s `resourceLoader.ts` `_noopLoad`, whose `Promise.resolve(undefined)`
// in a `Promise<unknown>` function is the only reason that module's header does not compile. The runtime half
// -- that an explicitly-typed settlement still carries the same value, in the same order, with an adopted
// rejection intact -- is pinned in tests/task_resolve_domain_test.cpp.
function emit(source: string) {
  const sourceFile = ts.createSourceFile('/flight/packages/math/src/promise.ts', source, ts.ScriptTarget.Latest, true);
  return emitIrModuleCpp(
    lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/math', upstreamDirectory: '/flight' }).module,
    { runtimeProfile: 'flight-cpp' },
  ).contents;
}

function captureBackendEmissionFailure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

describe('the domain a Promise.resolve settlement carries', () => {
  it('carries the declared domain when the literal is narrower', () => {
    const contents = emit(`export function noop(): Promise<unknown> { return Promise.resolve(undefined); }`);
    expect(contents).toContain('flight::Task<flight::Any> noop()');
    expect(contents).toContain('flight::resolve_task<flight::Any>(flight::undefined)');
  });

  it('carries it for a null literal too', () => {
    const contents = emit(`export function empty(): Promise<unknown> { return Promise.resolve(null); }`);
    expect(contents).toContain('flight::resolve_task<flight::Any>(nullptr)');
  });

  it('carries it for a primitive literal widened into an erased domain', () => {
    const contents = emit(`export function anyValue(): Promise<unknown> { return Promise.resolve(1); }`);
    expect(contents).toContain('flight::resolve_task<flight::Any>(1.0)');
  });

  it('leaves a literal already in the declared domain to deduction', () => {
    const contents = emit(`export function exact(): Promise<number> { return Promise.resolve(1); }`);
    expect(contents).toContain('flight::resolve_task(1.0)');
    expect(contents).not.toContain('resolve_task<double>');
  });

  it('leaves an exactly-undefined domain to deduction', () => {
    const contents = emit(`export function nothing(): Promise<undefined> { return Promise.resolve(undefined); }`);
    expect(contents).toContain('flight::Task<flight::Undefined> nothing()');
    expect(contents).toContain('flight::resolve_task(flight::undefined)');
  });

  it('keeps the source explicit type argument as the only one', () => {
    const contents = emit(`export function stated(): Promise<unknown> { return Promise.resolve<unknown>(undefined); }`);
    expect(contents).toContain('flight::resolve_task<flight::Any>(flight::undefined)');
    expect(contents).not.toContain('resolve_task<flight::Any><');
  });

  it('leaves an adopted task to the resolver overload that takes one', () => {
    const contents = emit(
      `export function adopt(task: Promise<number>): Promise<number> { return Promise.resolve(task); }`,
    );
    expect(contents).toContain('flight::resolve_task(task)');
    expect(contents).not.toContain('resolve_task<double>');
  });

  it('leaves a value already written in the declared domain alone', () => {
    const contents = emit(
      `export interface Outcome { readonly kind: string; }
       export function outcome(value: Outcome): Promise<unknown> { return Promise.resolve(value); }`,
    );
    // The value is already erased at the call boundary, so deduction answers with the declared domain.
    expect(contents).toContain('flight::resolve_task(flight::Any::object(value))');
    expect(contents).not.toContain('resolve_task<flight::Any>(flight::Any::object');
  });

  it('does not fire where the position states no promise domain', () => {
    const contents = emit(
      `export function bare(): unknown { const task: unknown = Promise.resolve(undefined); return task; }`,
    );
    // No declared task domain to carry: the rule has nothing to say and the emission is what it was.
    expect(contents).toContain('flight::resolve_task(flight::undefined)');
    expect(contents).not.toContain('resolve_task<flight::Any>');
  });

  it('leaves generic and callable values on their exact deduction paths', () => {
    const contents = emit(
      `export function generic<Value>(value: Value): Promise<Value> { return Promise.resolve(value); }
       export function callable(value: () => number): Promise<() => number> { return Promise.resolve(value); }`,
    );
    expect(contents.match(/flight::resolve_task\(value\)/gu)).toHaveLength(2);
    expect(contents).not.toContain('resolve_task<Value>');
    expect(contents).not.toContain('resolve_task<std::function');
  });

  it('evaluates a contextual erased call result once', () => {
    const contents = emit(
      `function nextValue(): number { return 1; }
       export function once(): Promise<unknown> { return Promise.resolve(nextValue()); }`,
    );
    const settlement = contents.match(/return flight::resolve_task\([^;\n]*next_value\(\)[^;\n]*\);/gu);
    expect(settlement).toHaveLength(1);
    expect(contents).not.toContain('resolve_task<flight::Any>');
  });

  it('qualifies the exact imported nullable owner in an explicit settlement domain', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        {
          packageName: '@flighthq/types',
          sourceFile: ts.createSourceFile(
            '/flight/packages/types/src/contract.ts',
            'export interface Outcome { readonly reason: string }',
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/loader',
          sourceFile: ts.createSourceFile(
            '/flight/packages/loader/src/load.ts',
            `import type { Outcome } from '@flighthq/types/contract';
             export function empty(): Promise<Outcome | null> { return Promise.resolve(null); }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const contents = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: {
        packageTargets: {
          '@flighthq/loader': { includePrefix: 'flight/loader', namespace: 'flight::loader' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(contents).toContain(
      'flight::resolve_task<std::optional<flight::Ref<flight::types::Outcome>>>(std::nullopt)',
    );
  });

  it('carries a uniquely selected literal into a multi-domain settlement', () => {
    const contents = emit(`export function choose(): Promise<number | string> { return Promise.resolve(1); }`);
    expect(contents).toContain('flight::Task<std::variant<double, flight::String>> choose()');
    expect(contents).toContain('flight::resolve_task<std::variant<double, flight::String>>');
  });

  it('retains the contextual refusal for an ambiguous multi-owner literal', () => {
    const failure = captureBackendEmissionFailure(() =>
      emit(
        `interface Left { readonly value: number }
         interface Right { readonly value: number }
         export function ambiguous(): Promise<Left | Right> { return Promise.resolve({ value: 1 }); }`,
      ),
    );
    expect(failure.rule).toBe('cpp-contextual-union-value-type-unrepresented');
  });
});

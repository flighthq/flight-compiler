import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

// TypeScript lets a callable with FEWER accepted parameters be stored where a wider callable is promised: the
// extra arguments are passed and the source ignores them. `std::function` refuses the narrower signature, so
// the emitter wraps such a source in an adapter that takes the target's whole parameter list and forwards
// exactly what the source accepts.
//
// What the adapter must not change: the arguments the source does receive (the first ones, in order), the
// callable it is (a bound or captured callable is captured by value, so its identity is preserved), the value
// it returns (the adapter returns the source's result, so the return domain is the declared one), and an
// exception it raises (the adapter does not catch).
//
// The measured site is `@flighthq/loader`'s `resourceLoader.ts`, where `_noopLoad` (one parameter) is stored
// into `PendingEntry.wrappedLoad` (two), and its header does not compile without this.
function emit(source: string) {
  const sourceFile = ts.createSourceFile('/flight/packages/math/src/arity.ts', source, ts.ScriptTarget.Latest, true);
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

describe('a callable with fewer accepted parameters stored into a wider callable', () => {
  it('adapts one parameter into the two the target promises', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      function one(a: number): number { return a; }
      export function use(): Wrapped { return one; }`);
    // The wrapper takes the contextual signature and forwards only what the source accepts. A DECLARATION
    // is a stateless function address, so it is invoked directly rather than captured.
    expect(contents).toContain(
      'return [](double contextual_callable_argument0, flight::String contextual_callable_argument1) -> double { return one(contextual_callable_argument0); };',
    );
  });

  it('adapts a callable that accepts nothing at all', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      function none(): number { return 7; }
      export function use(): Wrapped { return none; }`);
    expect(contents).toContain(
      'return [](double contextual_callable_argument0, flight::String contextual_callable_argument1) -> double { return none(); };',
    );
  });

  it('leaves an equal signature alone', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      function two(a: number, b: string): number { return a; }
      export function use(): Wrapped { return two; }`);
    expect(contents).toContain('return two;');
    expect(contents).not.toContain('contextual_callable_argument0');
  });

  it('adapts the field the loader stores, not only a returned value', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      export interface Holder { wrapped: Wrapped; }
      function one(a: number): number { return a; }
      export function fill(holder: Holder): void { holder.wrapped = one; }`);
    expect(contents).toContain(
      '(holder->wrapped = [](double contextual_callable_argument0, flight::String contextual_callable_argument1) -> double { return one(contextual_callable_argument0); });',
    );
  });

  it('keeps a captured callable, by value, with its identity', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      export function use(): Wrapped { const local = (a: number): number => a; return local; }`);
    // A produced callable is evaluated ONCE and retained by value, so the wrapper holds the callable the
    // source named -- and the call it makes is to that stored callable, not to a fresh one per invocation.
    expect(contents).toContain('return [contextual_callable = local](double contextual_callable_argument0');
    expect(contents).toContain('return contextual_callable(contextual_callable_argument0);');
  });

  it('evaluates a produced callable once before retaining it by value', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      function make(): (a: number) => number { return (a: number): number => a; }
      export function use(): Wrapped { return make(); }`);
    expect(contents).toContain('return [contextual_callable = make()](double contextual_callable_argument0');
    expect(contents.match(/contextual_callable = make\(\)/gu)).toHaveLength(1);
    expect(contents).toContain('return contextual_callable(contextual_callable_argument0);');
  });

  it('keeps a bound callable reached through its receiver', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => number;
      export interface Target { one(a: number): number; }
      export function use(target: Target): Wrapped { return target.one; }`);
    expect(contents).toContain('return [contextual_callable = target->one](double contextual_callable_argument0');
    expect(contents).toContain('return contextual_callable(contextual_callable_argument0);');
  });

  it('returns the source result through the adapter, whatever its domain', () => {
    const contents = emit(`export type Wrapped = (a: number, b: string) => Promise<number>;
      function one(a: number): Promise<number> { return Promise.resolve(a); }
      export function use(): Wrapped { return one; }`);
    expect(contents).toContain('-> flight::Task<double> { return one(contextual_callable_argument0); }');
  });

  it('supplies a source that declares MORE parameters, when the extras are optional', () => {
    const contents = emit(`export type Narrow = (a: number) => number;
      function withOptional(a: number, b?: string): number { return a; }
      export function use(): Narrow { return withOptional; }`);
    // The target promises one argument, so only one is forwarded and the source's optional parameter is
    // supplied absence -- the same call the source language makes.
    expect(contents).toContain(
      'return [](double contextual_callable_argument0) -> double { return with_optional(contextual_callable_argument0, std::nullopt); };',
    );
  });

  it('collects the arguments a rest-parameter source accepts', () => {
    const contents = emit(`export type Wrapped = (a: number, b: number) => number;
      function spread(...values: number[]): number { return values.length; }
      export function use(): Wrapped { return spread; }`);
    expect(contents).toContain(
      'return spread(flight::Array<double>{contextual_callable_argument0, contextual_callable_argument1});',
    );
  });

  it('refuses a source that requires more parameters than the target promises', () => {
    const failure = captureBackendEmissionFailure(() =>
      emit(`export type Narrow = (a: number) => number;
        function two(a: number, b: string): number { return a; }
        export function use(): Narrow { return two; }`),
    );
    expect(failure.rule).toBe('cpp-callable-arity-narrowing-unrepresented');
    expect(failure.message).toContain('fewer arguments than it declares');
  });

  it('refuses an arity adapter whose shared parameter domain is incompatible', () => {
    const failure = captureBackendEmissionFailure(() =>
      emit(`export type Wrapped = (a: number, b: boolean) => number;
        function one(a: string): number { return a.length; }
        export function use(): Wrapped { return one; }`),
    );
    expect(failure.rule).toBe('cpp-callable-arity-adaptation-unrepresented');
    expect(failure.message).toContain('parameter 1');
  });

  it('refuses an arity adapter whose result has an incompatible carrier', () => {
    const failure = captureBackendEmissionFailure(() =>
      emit(`export type Wrapped = (a: number, b: boolean) => number;
        function one(a: number): string { return String(a); }
        export function use(): Wrapped { return one; }`),
    );
    expect(failure.rule).toBe('cpp-callable-arity-adaptation-unrepresented');
    expect(failure.message).toContain('return carrier');
  });

  it('leaves ambiguous callable unions on their existing stable refusal path', () => {
    const failure = captureBackendEmissionFailure(() =>
      emit(`type First = (a: number, b: string) => number;
        type Second = (a: number, b: boolean) => number;
        type Either = First | Second;
        function one(a: number): number { return a; }
        export function use(): Either { return one; }`),
    );
    expect(failure.rule).toBe('cpp-contextual-union-value-type-unrepresented');
    expect(failure.message).toContain("agrees with no alternative's signature");
  });
});

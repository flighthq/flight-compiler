import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';

function lower(file: string, source: string) {
  return lowerPackage('@flighthq/math', file, source);
}

function lowerPackage(packageName: string, file: string, source: string) {
  const packageDirectory = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageDirectory}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, {
    packageName,
    upstreamDirectory: '/flight',
  });
}

describe('createCppCompilerBackend', () => {
  it('creates independent stateless backend records with C++ identity', () => {
    const first = createCppCompilerBackend();
    const second = createCppCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;

    expect(first).not.toBe(second);
    expect(first.name).toBe('cpp');
    expect(first.emitModule(module, { modules: [module], options: {} })).toEqual([emitIrModuleCpp(module)]);
  });
});

describe('emitIrModuleCpp', () => {
  it('emits a simple constant declaration as a C++ header', () => {
    const result = lower('value.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.path).toBe('value.hpp');
    expect(emitted.contents).toContain('#pragma once');
    expect(emitted.contents).toContain('namespace flighthq_');
    expect(emitted.contents).toContain('const');
  });

  it('emits a function with parameters', () => {
    const result = lower('add.ts', 'export function add(a: number, b: number): number { return a + b; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.path).toBe('add.hpp');
    expect(emitted.contents).toContain('double add(double a, double b)');
    expect(emitted.contents).toContain('return');
  });

  it('emits an interface as a C++ struct with properties', () => {
    const result = lower('point.ts', 'export interface Point { x: number; y: number }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct');
    expect(emitted.contents).toContain('double');
  });

  it('emits async functions with C++20 coroutine syntax', () => {
    const result = lower('fetcher.ts', 'export async function fetchData(): Promise<number> { return 1; }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('FlightTask<double> fetch_data()');
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('#include <coroutine>');
  });

  it('emits co_await for await expressions in async functions', () => {
    const result = lower(
      'waiter.ts',
      'export async function wait(task: Promise<number>): Promise<number> { const v = await task; return v; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('co_await task');
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).not.toContain(' return ');
  });

  it('emits finally blocks with exception_ptr catch-rethrow', () => {
    const result = lower(
      'cleanup.ts',
      'export async function cleanup(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; } finally { r = r + 1; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).toContain('std::current_exception()');
    expect(emitted.contents).toContain('std::rethrow_exception');
    expect(emitted.contents).toContain('#include <exception>');
  });

  it('emits return-in-try-with-finally using deferred return variable', () => {
    const result = lower(
      'deferred.ts',
      'export async function deferred(task: Promise<number>): Promise<number> { try { return await task; } finally { let x: number = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('std::optional<double> finally_return');
    expect(emitted.contents).toContain('finally_return = co_await task');
    expect(emitted.contents).toContain('finally_return.has_value()');
    expect(emitted.contents).toContain('co_return finally_return.value()');
  });

  it('emits class inheritance with virtual destructor and initializer list', () => {
    const result = lower(
      'derived.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } doubled(): number { return this.value * 2; } } export class Derived extends Base { extra: number; constructor(v: number) { super(v); this.extra = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct Base {');
    expect(emitted.contents).toContain('virtual ~Base() = default;');
    expect(emitted.contents).toContain('virtual double doubled()');
    expect(emitted.contents).toContain('struct Derived : public Base {');
    expect(emitted.contents).toContain(': Base(v)');
  });

  it('emits type parameters as PascalCase and value bindings as snake_case', () => {
    const result = lower(
      'container.ts',
      'export interface Box<Value> { contents: Value } export function unwrap<Value>(box: Box<Value>): Value { return box.contents; }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('template <typename Value>');
    expect(emitted.contents).toContain('Value contents');
    expect(emitted.contents).toContain('Box<Value>');
    expect(emitted.contents).toContain('Value unwrap');
    expect(emitted.contents).not.toContain('value contents');
    expect(emitted.contents).not.toContain('value unwrap');
  });

  it('emits abstract methods as pure virtual', () => {
    const result = lower(
      'shape.ts',
      'export abstract class Shape { abstract area(): number; describe(): number { return this.area(); } } export class Square extends Shape { side: number; constructor(s: number) { super(); this.side = s; } area(): number { return this.side * this.side; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('virtual double area() = 0;');
    expect(emitted.contents).toContain('double area() override');
  });
});

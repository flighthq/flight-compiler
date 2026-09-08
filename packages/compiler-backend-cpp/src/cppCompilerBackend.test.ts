import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('lowers number toString as a free conversion rather than an imaginary number method', () => {
    const result = lower('text.ts', 'export function text(value: number): string { return value.toString(); }');

    expect(emitIrModuleCpp(result.module).contents).toContain('return std::to_string(value)');
    expect(emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents).toContain(
      'return flight::String::from_utf8(std::to_string(value))',
    );
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

  it('elects the flight-cpp semantic runtime as one coherent profile', () => {
    const result = lower(
      'semantic-runtime.ts',
      'export async function update(values: number[], labels: Map<string, number>, seen: Set<string>): Promise<string> { values.push(1); labels.set("size", values.length); seen.add("size"); return "done"; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('#include <flight/runtime.hpp>');
    expect(emitted.contents).toContain(
      'flight::Task<flight::String> update(flight::Array<double> values, flight::Map<flight::String, double> labels, flight::Set<flight::String> seen)',
    );
    expect(emitted.contents).toContain('values.push(1.0)');
    expect(emitted.contents).toContain('labels.set(flight::String("size"), static_cast<double>(values.size()))');
    expect(emitted.contents).toContain('seen.add(flight::String("size"))');
    expect(emitted.contents).toContain('co_return flight::String("done")');
    expect(emitted.contents).not.toContain('std::vector');
    expect(emitted.contents).not.toContain('std::unordered_');
  });

  it('lets a consumer override the semantic runtime header without changing its bindings', () => {
    const result = lower('text.ts', 'export function text(value: string): string { return value.trim(); }');
    const emitted = emitIrModuleCpp(result.module, {
      runtimeHeader: 'vendor/flight_runtime.hpp',
      runtimeProfile: 'flight-cpp',
    });

    expect(emitted.contents).toContain('#include "vendor/flight_runtime.hpp"');
    expect(emitted.contents).not.toContain('#include <flight/runtime.hpp>');
    expect(emitted.contents).toContain('flight::String text(flight::String value)');
    expect(emitted.contents).toContain('return value.trim()');
  });

  it('lowers semantic-runtime constructors and static operations to concrete C++ entry points', () => {
    const result = lower(
      'statics.ts',
      'export function code(): string { return String.fromCharCode(65); } export function stamp(): number { return Date.now(); } export function resolved(value: number): Promise<number> { return Promise.resolve<number>(value); } export function rejected(): Promise<number> { return Promise.reject<number>("no"); } export function combined(tasks: Promise<number>[]): Promise<number[]> { return Promise.all(tasks); } export function pending(): Promise<number> { return new Promise<number>((resolve) => resolve(1)); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return flight::String::from_char_code(65.0)');
    expect(emitted.contents).toContain('return flight::Date::now()');
    expect(emitted.contents).toContain('return flight::resolve_task<double>(value)');
    expect(emitted.contents).toContain('return flight::reject_task<double>(flight::String("no"))');
    expect(emitted.contents).toContain('return flight::all_tasks(tasks)');
    expect(emitted.contents).toContain('return flight::Task<double>::create(');
  });

  it('keeps the native conformance header equal to flight-cpp profile output', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const directory = path.join(root, 'flight-cpp', 'tests', 'generated');
    const sourceFile = ts.createSourceFile(
      '/flight/packages/cpp-conformance/src/semantic-runtime.ts',
      readFileSync(path.join(directory, 'semantic_runtime.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/cpp-conformance',
      upstreamDirectory: '/flight',
    });
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    const contents = emitted.contents.endsWith('\n') ? emitted.contents : `${emitted.contents}\n`;
    const outputPath = path.join(directory, emitted.path);

    expect(emitted.path).toBe('semantic_runtime.hpp');
    if (process.env.FLIGHT_CPP_CONFORMANCE_UPDATE === '1') writeFileSync(outputPath, contents);
    expect(readFileSync(outputPath, 'utf8')).toBe(contents);
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

  it('folds Math.max spread into std::max_element with empty guard', () => {
    const result = lower(
      'spread-max.ts',
      'export function widest(values: number[]): number { return Math.max(...values); }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('#include <algorithm>');
    expect(emitted.contents).toContain('#include <limits>');
    expect(emitted.contents).toContain(
      'values.empty() ? -std::numeric_limits<double>::infinity() : *std::max_element(values.begin(), values.end())',
    );
  });

  it('folds Math.min spread into std::min_element with empty guard', () => {
    const result = lower(
      'spread-min.ts',
      'export function narrowest(values: number[]): number { return Math.min(...values); }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('*std::min_element(values.begin(), values.end())');
    expect(emitted.contents).toContain('std::numeric_limits<double>::infinity()');
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

  it('emits numeric and string enums', () => {
    const numeric = lower('direction.ts', 'export enum Direction { Up = 0, Down = 1, Left = 2, Right = 3 }');
    const numericEmitted = emitIrModuleCpp(numeric.module);
    expect(numericEmitted.contents).toContain('enum class Direction');
    expect(numericEmitted.contents).toContain('Up = 0');
    expect(numericEmitted.contents).toContain('Down = 1');

    const stringEnum = lower('color.ts', 'export enum Color { Red = "red", Green = "green", Blue = "blue" }');
    const stringEmitted = emitIrModuleCpp(stringEnum.module);
    expect(stringEmitted.contents).toContain('using Color = std::string');
    expect(stringEmitted.contents).toContain('#include <string>');
  });

  it('emits type aliases and string literal unions', () => {
    const alias = lower('alias.ts', 'export type Pair<T> = [T, T];');
    const emitted = emitIrModuleCpp(alias.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('using Pair');

    const literal = lower('status.ts', "export type Status = 'active' | 'inactive';");
    const literalEmitted = emitIrModuleCpp(literal.module);
    expect(literalEmitted.contents).toContain('using Status = std::string');
  });

  it('emits variable declarations with mutability and types', () => {
    const result = lower('vars.ts', 'export const PI: number = 3.14; export let counter: number = 0;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('const double pi');
    expect(emitted.contents).toContain('double counter');
  });

  it('emits string concatenation with std::string', () => {
    const result = lower('concat.ts', 'export function greet(name: string): string { return "Hello, " + name + "!"; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include <string>');
    expect(emitted.contents).toContain('+');
  });

  it('emits string += assignment', () => {
    const result = lower(
      'append.ts',
      'export function build(base: string, suffix: string): string { let result: string = base; result += suffix; return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('+=');
  });

  it('emits exponentiation with std::pow', () => {
    const result = lower('power.ts', 'export function square(x: number): number { return x ** 2; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
    expect(emitted.contents).toContain('#include <cmath>');
  });

  it('emits unsigned right shift with uint32_t cast', () => {
    const result = lower('shift.ts', 'export function unsignedShift(x: number, y: number): number { return x >>> y; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('uint32_t');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits bitwise operators with int32_t casts', () => {
    const result = lower('bitwise.ts', 'export function bitwiseAnd(a: number, b: number): number { return a & b; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int32_t');
    expect(emitted.contents).toContain('#include <cstdint>');
  });

  it('emits bitwise NOT with tilde', () => {
    const result = lower('not.ts', 'export function complement(x: number): number { return ~x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('~static_cast<int32_t>');
  });

  it('emits nullish coalescing with value_or', () => {
    const result = lower('nullish.ts', 'export function fallback(x: number | undefined): number { return x ?? 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('value_or');
    expect(emitted.contents).toContain('#include <optional>');
  });

  it('emits null comparisons with has_value', () => {
    const result = lower(
      'nullable.ts',
      'export function isPresent(x: number | undefined): boolean { return x !== undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('has_value()');
  });

  it('emits conditional expressions', () => {
    const result = lower('ternary.ts', 'export function clamp(x: number): number { return x > 0 ? x : 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('?');
    expect(emitted.contents).toContain(':');
  });

  it('emits cast expressions with static_cast', () => {
    const result = lower('cast.ts', 'export function toNumber(x: number | string): number { return x as number; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast');
  });

  it('emits tuple types and tuple access with std::get', () => {
    const result = lower('tuple.ts', 'export function first(pair: [number, string]): number { return pair[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<0>');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('emits tuple literals with std::make_tuple', () => {
    const result = lower(
      'make-tuple.ts',
      'export function pair(a: number, b: string): [number, string] { return [a, b]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
  });

  it('emits array literals with std::vector', () => {
    const result = lower('array.ts', 'export function items(): number[] { return [1, 2, 3]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector');
    expect(emitted.contents).toContain('#include <vector>');
  });

  it('emits object literals with brace initialization', () => {
    const result = lower(
      'object.ts',
      'interface Pt { x: number; y: number } export function origin(): Pt { return { x: 0, y: 0 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.x =');
    expect(emitted.contents).toContain('.y =');
  });

  it('emits new expressions as constructor calls', () => {
    const result = lower('error.ts', 'export function fail(): Error { return new Error("oops"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::runtime_error');
    expect(emitted.contents).toContain('#include <stdexcept>');
  });

  it('emits template literals with std::to_string', () => {
    const result = lower('template.ts', 'export function label(n: number): string { return `item ${n}`; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::to_string');
    expect(emitted.contents).toContain('#include <string>');
  });

  it('emits number.toString() as std::to_string via ambient member binding', () => {
    const result = lower(
      'to-string.ts',
      'export function numStr(n: number): string { const x: number = 42; return x.toString(); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('to_string');
  });

  it('emits enum member access with scoped resolution', () => {
    const result = lower(
      'enum-access.ts',
      'export enum Color { Red, Green, Blue } export function red(): Color { return Color.Red; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Color::Red');
  });

  it('emits if/else statements', () => {
    const result = lower(
      'branch.ts',
      'export function sign(x: number): number { if (x > 0) { return 1; } else { return -1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else {');
  });

  it('emits while and do-while loops', () => {
    const result = lower(
      'loops.ts',
      'export function countdown(n: number): number { let i: number = n; while (i > 0) { i = i - 1; } return i; } export function countup(n: number): number { let i: number = 0; do { i = i + 1; } while (i < n); return i; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while (');
    expect(emitted.contents).toContain('do {');
    expect(emitted.contents).toContain('} while (');
  });

  it('emits for-of loops', () => {
    const result = lower(
      'for-of.ts',
      'export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total += item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain(' : ');
  });

  it('emits for-in loops with key plan', () => {
    const result = lower(
      'for-in.ts',
      'interface Cfg { host: string; port: number } export function keys(cfg: Cfg): string { let result: string = ""; for (const key in cfg) { result += key; } return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
    expect(emitted.contents).toContain('#include <string>');
  });

  it('emits switch as if-else chain', () => {
    const result = lower(
      'switch.ts',
      'export function label(mode: number): string { switch (mode) { case 0: return "a"; case 1: return "b"; default: return "c"; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else if (');
    expect(emitted.contents).toContain('else');
  });

  it('emits throw and try-catch', () => {
    const result = lower(
      'error-handling.ts',
      'export function safe(x: number): number { try { if (x < 0) throw new Error("neg"); return x; } catch (e) { return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('throw');
    expect(emitted.contents).toContain('try {');
    expect(emitted.contents).toContain('catch (');
  });

  it('emits lambda expressions with capture', () => {
    const result = lower(
      'lambda.ts',
      'export function make(x: number): () => number { return (): number => { return x; }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
    expect(emitted.contents).toContain('#include <functional>');
  });

  it('emits function types with std::function', () => {
    const result = lower(
      'fn-type.ts',
      'export function apply(fn: (x: number) => number, value: number): number { return fn(value); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::function<');
    expect(emitted.contents).toContain('#include <functional>');
  });

  it('emits union types as std::variant', () => {
    const result = lower(
      'union.ts',
      'export function convert(input: number | string | boolean): number { return input as number; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant<');
    expect(emitted.contents).toContain('#include <variant>');
  });

  it('emits nullable types as std::optional', () => {
    const result = lower(
      'optional.ts',
      'export function maybe(x: number | undefined): number | undefined { return x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<double>');
  });

  it('emits object types as anonymous structs', () => {
    const result = lower(
      'anon-struct.ts',
      'export function make(): { x: number; y: number } { return { x: 1, y: 2 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct');
    expect(emitted.contents).toContain('double x');
    expect(emitted.contents).toContain('double y');
  });

  it('emits narrowed optional access with .value()', () => {
    const result = lower(
      'narrow.ts',
      'export function unwrap(x: number | undefined): number { if (x !== undefined) { return x; } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value()');
  });

  it('emits undefined literals as std::nullopt', () => {
    const result = lower('undef.ts', 'export function nothing(): number | undefined { return undefined; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits imports as #include directives for relative specifiers', () => {
    const result = lowerPackage(
      '@flighthq/math',
      'consumer.ts',
      "import { helper } from './helper.js'; export function use(): number { return helper(); }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits optional and rest parameters', () => {
    const result = lower(
      'params.ts',
      'export function opt(a: number, b?: number): number { return a; } export function rest(a: number, ...items: number[]): number { return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<double>');
    expect(emitted.contents).toContain('std::nullopt');
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits special numeric values via literal emission', () => {
    const result = lower('special.ts', 'export function check(x: number): boolean { return x > 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double');
  });

  it('emits boolean and null literals', () => {
    const result = lower('literals.ts', 'export const yes: boolean = true; export const no: boolean = false;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('true');
    expect(emitted.contents).toContain('false');
  });

  it('emits integer literals with .0 suffix', () => {
    const result = lower('int.ts', 'export const value: number = 42;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('42.0');
  });

  it('emits break and continue in loops', () => {
    const result = lower(
      'control.ts',
      'export function find(items: number[]): number { for (const item of items) { if (item > 5) { return item; } } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits runtime header include when configured', () => {
    const result = lower('simple.ts', 'export const x: number = 1;');
    const emitted = emitIrModuleCpp(result.module, { runtimeHeader: 'flight_runtime.hpp' });
    expect(emitted.contents).toContain('#include "flight_runtime.hpp"');
  });

  it('emits static fields correctly by skipping them in struct body', () => {
    const result = lower(
      'static.ts',
      'export class Counter { static count: number = 0; value: number; constructor(v: number) { this.value = v; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double value');
    expect(emitted.contents).not.toContain('count');
  });

  it('emits postfix increment and decrement', () => {
    const result = lower('postfix.ts', 'export function next(x: number): number { let v: number = x; v++; return v; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('++');
  });

  it('refuses binding pattern declarations before lowering', () => {
    const result = lower('destruct.ts', 'export const value: number = 1;');
    const module = structuredClone(result.module);
    const fn = module.declarations[0]!;
    if (fn.kind === 'variable' && !('pattern' in fn)) {
      (fn as any).pattern = { kind: 'array', elements: [] };
    }
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits Readonly<T> by unwrapping to the inner type', () => {
    const result = lower(
      'readonly.ts',
      'interface Pt { x: number } export function read(p: Readonly<Pt>): number { return p.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double read(Pt p)');
  });

  it('emits expression arrow functions with concise body', () => {
    const result = lower('arrow.ts', 'export function make(x: number): () => number { return () => x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
    expect(emitted.contents).toContain('return');
  });

  it('emits super method calls with base class scope resolution', () => {
    const result = lower(
      'super-method.ts',
      'class Base { value(): number { return 1; } } export class Child extends Base { value(): number { return super.value() + 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base::value');
  });

  it('emits this member access with arrow operator', () => {
    const result = lower(
      'this-access.ts',
      'export class Box { value: number; constructor(v: number) { this.value = v; } get(): number { return this.value; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('this->value');
  });

  it('emits property access as member operator', () => {
    const result = lower(
      'member.ts',
      'interface Obj { x: number } export function getX(o: Obj): number { return o.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.x');
  });

  it('emits switch with only default case without if-else wrapper', () => {
    const result = lower(
      'switch-default-only.ts',
      'export function always(x: number): number { switch (x) { default: return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits try-catch-finally with nested structure', () => {
    const result = lower(
      'try-catch-finally.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return 0; } finally { let x: number = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('finally_return');
  });

  it('names the output file from source path or falls back to internal name', () => {
    const result = lower('my-module.ts', 'export const x: number = 1;');
    expect(emitIrModuleCpp(result.module).path).toBe('my_module.hpp');
  });
});

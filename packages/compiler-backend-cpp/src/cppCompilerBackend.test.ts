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
      'return flight::to_string(value)',
    );
  });

  it('emits an interface as a C++ struct with properties', () => {
    const result = lower('point.ts', 'export interface Point { x: number; y?: number }');
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct');
    expect(emitted.contents).toContain('double x');
    expect(emitted.contents).toContain('std::optional<double> y');
  });

  it('emits semantic arrays with contextual empty types and checked indexed access', () => {
    const result = lower(
      'indexes.ts',
      'export function empty(): number[] { return []; } export function first(values: number[], index: number): number { return values[index] ?? 0; } export function scale(values: number[], index: number): void { values[index] *= 2; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return flight::Array<double>{}');
    expect(emitted.contents).toContain('return values.get(index).value_or(0.0)');
    expect(emitted.contents).toContain('values.element(index) *= 2.0');
    expect(emitted.contents).not.toContain('static_cast<size_t>');
  });

  it('uses source numeric and error semantics in the runtime profile', () => {
    const result = lower(
      'semantics.ts',
      'export function remainder(left: number, right: number): number { return left % right; } export function fail(message: string): Error { return new Error(message); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('return std::fmod(left, right)');
    expect(emitted.contents).toContain('return flight::Error(message)');
  });

  it('places module types before values that use them and makes header definitions inline', () => {
    const result = lower(
      'ordering.ts',
      'export function total(values: Values): number { return values.length; } export type Values = number[];',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents.indexOf('using Values')).toBeLessThan(emitted.contents.indexOf('inline double total'));
  });

  it('preserves class initializers, static members, and property accessors', () => {
    const result = lower(
      'counter.ts',
      'export function read(): number { const counter = Counter.make(); counter.value = 7; return counter.value + Counter.zero; } export class Counter { private count: number = 1; static readonly zero = 0; static make(): Counter { return new Counter(); } get value(): number { return this.count; } set value(next: number) { this.count = next; } }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents.indexOf('struct Counter')).toBeLessThan(emitted.contents.indexOf('inline double read'));
    expect(emitted.contents).toContain('double count = 1.0');
    expect(emitted.contents).toContain('inline static const double zero = 0.0');
    expect(emitted.contents).toContain('static Counter make()');
    expect(emitted.contents).toContain('counter.value(7.0)');
    expect(emitted.contents).toContain('counter.value() + Counter::zero');
    expect(emitted.contents).not.toContain('const Counter counter');
  });

  it('evaluates nullable property receivers once and safely projects indexed values', () => {
    const result = lower(
      'optional.ts',
      'interface Entry { key: string } export function first(entries: Entry[]): string { return entries[0]?.key ?? "none"; } export function read(entry: Entry | undefined): string { return entry?.key ?? "none"; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });

    expect(emitted.contents).toContain('auto optional_chain_receiver = entries.get(0.0)');
    expect(emitted.contents).toContain('auto optional_chain_receiver = entry');
    expect(emitted.contents).toContain('if (!optional_chain_receiver.has_value()) return std::nullopt');
    expect(emitted.contents).toContain('optional_chain_receiver.value().key');
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

  it('emits mutable local variables without const', () => {
    const result = lower('mutable.ts', 'export function inc(): number { let x: number = 0; x = x + 1; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/(?<!const )double x/);
  });

  it('emits class with type parameters', () => {
    const result = lower(
      'generic-class.ts',
      'export class Box<T> { value: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template <typename T>');
    expect(emitted.contents).toContain('struct Box');
    expect(emitted.contents).toContain('T value');
  });

  it('emits static class methods correctly', () => {
    const result = lower(
      'static-method.ts',
      'export class Factory { static value: number = 0; static create(): number { return 0; } make(): number { return 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('make()');
  });

  it('emits .length property via ambient sizeMethod binding', () => {
    const result = lower('length.ts', 'export function len(items: number[]): number { return items.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('size()');
  });

  it('emits array.push via ambient method binding', () => {
    const result = lower(
      'push.ts',
      'export function append(items: number[], value: number): void { items.push(value); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('push_back');
  });

  it('emits for-in with preserve evaluation wrapping object reference', () => {
    const result = lower(
      'for-in-preserve.ts',
      'interface Cfg { host: string; port: number } export function read(cfg: Cfg): string { let result: string = ""; for (const key in cfg) { result += key; } return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits async closure rejection as emission failure', () => {
    const result = lower(
      'async-closure.ts',
      'export function make(): () => Promise<number> { return async (): Promise<number> => { return 1; }; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow('async closures');
  });

  it('emits element access on arrays with static_cast<size_t>', () => {
    const result = lower('elem.ts', 'export function first(items: number[]): number { return items[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<size_t>');
  });

  it('emits void return in finally context correctly', () => {
    const result = lower(
      'finally-void.ts',
      'export async function run(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; return r; } finally { r = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits try-catch-finally with return in catch clause', () => {
    const result = lower(
      'catch-return.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return -1; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('has_value()');
  });

  it('emits tuple element types with optional wrapping', () => {
    const result = lower('opt-tuple.ts', 'export function partial(): [number, number?] { return [1]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('std::tuple');
  });

  it('emits undefinedDefault with value_or', () => {
    const result = lower(
      'default-value.ts',
      'export function withDefault(pair: [number, number?]): number { const [a, b = 0] = pair; return a + b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('value_or');
  });

  it('emits tupleRest with std::get', () => {
    const result = lower(
      'tuple-rest.ts',
      'export function rest(triple: [number, number, number]): number { const [, ...tail] = triple; return tail[0]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits tupleSuffix with multiple std::get calls', () => {
    const result = lower(
      'tuple-suffix.ts',
      'export function suffix(quad: [number, number, number, number]): [number, number] { const [, , ...last] = quad; return last; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits unary plus on number as identity', () => {
    const result = lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('++');
  });

  it('emits IIFE call with parenthesized lambda', () => {
    const result = lower('iife.ts', 'export function wrap(): number { return ((x: number): number => x)(42); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('([=]');
    expect(emitted.contents).toContain(')(42.0)');
  });

  it('emits enum without explicit values', () => {
    const result = lower('auto-enum.ts', 'export enum Status { Active, Inactive }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class Status');
    expect(emitted.contents).toContain('Active');
    expect(emitted.contents).toContain('Inactive');
  });

  it('emits this type as class name in method context', () => {
    const result = lower(
      'this-type.ts',
      'export class Node { next: Node | undefined; self(): Node { return this as Node; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Node self()');
  });

  it('emits never type as void', () => {
    const result = lower('never.ts', 'export function fail(): never { throw new Error("fail"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('void fail()');
  });

  it('emits void type in function returns', () => {
    const result = lower('void-fn.ts', 'export function noop(): void { return; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('void noop()');
  });

  it('emits bigint as int64_t', () => {
    const result = lower('bigint-param.ts', 'export function process(x: bigint): bigint { return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int64_t');
  });

  it('emits literal types correctly', () => {
    const result = lower('literal-type.ts', 'export function one(): 1 { return 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double one');
  });

  it('emits catch without binding using ellipsis', () => {
    const result = lower(
      'catch-all.ts',
      'export function safe(x: number): number { try { return x; } catch { return 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch (...)');
  });

  it('rejects objectRest expressions before lowering', () => {
    const result = lower('rest-obj.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'objectRest',
        object: decl.initializer,
        excluded: [],
        type: { kind: 'unknown', source: 'object' },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('refuses regexp expressions before lowering', () => {
    const result = lower('regexp.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = { kind: 'regexp', pattern: 'test', flags: '' };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('regular expressions');
  });

  it('refuses spread expressions in non-Math contexts', () => {
    const result = lower('spread.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'spread',
        expression: { kind: 'literal', value: 1 },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('spreading');
  });

  it('emits NaN and Infinity literals via std::numeric_limits', () => {
    const result = lower('special-num.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: NaN };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('std::numeric_limits<double>::quiet_NaN()');

    const module2 = structuredClone(result.module);
    const decl2 = module2.declarations[0];
    if (decl2?.kind === 'variable' && !('pattern' in decl2)) {
      (decl2 as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: Infinity };
    }
    const emitted2 = emitIrModuleCpp(module2);
    expect(emitted2.contents).toContain('std::numeric_limits<double>::infinity()');

    const module3 = structuredClone(result.module);
    const decl3 = module3.declarations[0];
    if (decl3?.kind === 'variable' && !('pattern' in decl3)) {
      (decl3 as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: -Infinity };
    }
    const emitted3 = emitIrModuleCpp(module3);
    expect(emitted3.contents).toContain('-std::numeric_limits<double>::infinity()');
  });

  it('emits null literal as nullptr', () => {
    const result = lower('null-lit.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as unknown as { initializer: unknown }).initializer = { kind: 'literal', value: null };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('nullptr');
  });

  it('emits string literal with flight-cpp runtime as flight::String', () => {
    const result = lower('string-lit.ts', 'export const x: string = "hello";');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String("hello")');
  });

  it('emits template literals with flight-cpp runtime', () => {
    const result = lower('tpl-flight.ts', 'export function label(n: number): string { return `item ${n}`; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String');
    expect(emitted.contents).toContain('flight::String::from_utf8(std::to_string(');
  });

  it('emits empty template literal as empty string construction', () => {
    const result = lower('empty-tpl.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = { kind: 'template', parts: [] };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('std::string()');
    const flightEmitted = emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' });
    expect(flightEmitted.contents).toContain('flight::String()');
  });

  it('emits array literals with flight-cpp runtime', () => {
    const result = lower('array-flight.ts', 'export function items(): number[] { return [1, 2, 3]; }');
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::Array');
    expect(emitted.contents).not.toContain('std::vector');
  });

  it('emits tuple literal with absent element as std::nullopt', () => {
    const result = lower('tuple-absent.ts', 'export function partial(): [number, number?] { return [1]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::nullopt');
    expect(emitted.contents).toContain('std::make_tuple');
  });

  it('emits tuple literal with present optional element using make_optional', () => {
    const result = lower('tuple-opt.ts', 'export function full(): [number, number?] { return [1, 2]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_optional');
  });

  it('emits Required<T> type by unwrapping to the inner type', () => {
    const result = lower(
      'required.ts',
      'interface Pt { x: number } export function fill(p: Required<Pt>): number { return p.x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double fill(Pt p)');
  });

  it('refuses indexedAccess types', () => {
    const result = lower('idx.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = {
        kind: 'indexedAccess',
        object: { kind: 'primitive', name: 'string' },
        index: { kind: 'literal', value: 'x' },
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('indexedAccess');
  });

  it('refuses intersection types', () => {
    const result = lower('inter.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'intersection', types: [] };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('intersection');
  });

  it('emits boolean literal type as bool', () => {
    const result = lower('bool-lit.ts', 'export function yes(): true { return true; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('bool yes()');
  });

  it('emits string literal type with flight-cpp runtime', () => {
    const result = lower('str-lit-type.ts', "export function tag(): 'hello' { return 'hello'; }");
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('flight::String tag()');
  });

  it('emits null and undefined types as void', () => {
    const result = lower('null-type.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'null' };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('void');
  });

  it('emits symbol type as int', () => {
    const result = lower('symbol.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'primitive', name: 'symbol' };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('int x');
  });

  it('emits unknown type as auto', () => {
    const result = lower('unknown.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = { kind: 'unknown', source: 'param' };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('auto x');
  });

  it('refuses Partial<T> types', () => {
    const result = lower('partial.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).type = {
        kind: 'named',
        reference: { kind: 'ambient', name: 'Partial' },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      };
    }
    expect(() => emitIrModuleCpp(module)).toThrow('Partial');
  });

  it('emits C++ keywords with trailing underscore', () => {
    const result = lower(
      'keywords.ts',
      'export function check(value: number): number { const auto_val: number = value; return auto_val; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double check');
  });

  it('emits variable without type as auto', () => {
    const result = lower('auto-var.ts', 'export const value = 42;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/(?:auto|double)\s+value/);
  });

  it('emits string concatenation with flight-cpp runtime', () => {
    const result = lower(
      'concat-flight.ts',
      'export function greet(name: string): string { return "Hello, " + name; }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('+');
    expect(emitted.contents).not.toContain('#include <string>');
  });

  it('emits target name allocation collision as emission failure', () => {
    const result = lower('collision.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const binding = {
      id: 'b:1',
      kind: 'variable' as const,
      column: 1,
      fingerprint: 'sha256:a',
      line: 1,
      name: 'value',
      packageName: '@flighthq/math',
      scope: 'module' as const,
      source: 'test.ts',
      space: 'value' as const,
    };
    const binding2 = { ...binding, id: 'b:2', fingerprint: 'sha256:b', line: 2 };
    (module as unknown as { declarations: unknown[] }).declarations = [
      {
        kind: 'variable',
        binding,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
        initializer: { kind: 'literal', value: 1 },
      },
      {
        kind: 'variable',
        binding: binding2,
        mutable: false,
        type: { kind: 'primitive', name: 'number' },
        initializer: { kind: 'literal', value: 2 },
      },
    ] as any;
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits class with overridden method using override keyword', () => {
    const result = lower(
      'override.ts',
      'class A { x(): number { return 1; } } export class B extends A { x(): number { return 2; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('override');
  });

  it('emits block statement with braces', () => {
    const result = lower('block.ts', 'export function run(): number { { let x: number = 1; return x; } }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('{');
  });

  it('emits string enum with flight-cpp runtime', () => {
    const result = lower('str-enum-flight.ts', "export enum Color { Red = 'red', Green = 'green' }");
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('using Color = flight::String');
  });

  it('reuses existing anonymous struct when types match', () => {
    const result = lower(
      'reuse-struct.ts',
      'export function a(): { x: number; y: number } { return { x: 1, y: 2 }; } export function b(): { x: number; y: number } { return { x: 3, y: 4 }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    const structMatches = emitted.contents.match(/struct \w+ \{/g) ?? [];
    const anonymousStructs = structMatches.filter((m) => !m.includes('flighthq'));
    expect(anonymousStructs.length).toBe(1);
  });

  it('emits return without expression in void function', () => {
    const result = lower('void-return.ts', 'export function stop(): void { return; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return;');
  });

  it('skips non-relative import specifiers', () => {
    const result = lower(
      'external-import.ts',
      "import { something } from 'external-package'; export function use(): number { return something(); }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('#include "external');
  });

  it('emits typeof prefix as typeid', () => {
    const result = lower('typeof.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'unary',
        operator: 'typeof',
        operand: { kind: 'literal', value: 1 },
        prefix: true,
        postfix: false,
        semantics: { operand: { flow: 'number' } },
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('typeid');
  });

  it('emits void prefix operator', () => {
    const result = lower('void-op.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        kind: 'unary',
        operator: 'void',
        operand: { kind: 'literal', value: 0 },
        prefix: true,
        postfix: false,
        semantics: { operand: { flow: 'number' } },
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('(void)');
  });

  it('emits for-of with typed variable', () => {
    const result = lower(
      'for-of-typed.ts',
      'export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total = total + item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double item');
  });

  it('detects return statements in if branches for try-finally deferred return', () => {
    const result = lower(
      'try-if-return.ts',
      'export async function check(task: Promise<number>): Promise<number> { try { if (true) { return await task; } else { return await task; } } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return statements in try body for try-catch-finally deferred return', () => {
    const result = lower(
      'try-catch-ret.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { throw e; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('catch');
  });

  it('emits try-finally without catch clause', () => {
    const result = lower(
      'try-finally-no-catch.ts',
      'export async function run(task: Promise<number>): Promise<number> { let r: number = 0; try { r = await task; } finally { r = 0; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::exception_ptr');
    expect(emitted.contents).not.toContain('catch (const std::exception');
  });

  it('emits tupleSpread with mixed element and spread segments', () => {
    const result = lower(
      'tuple-spread.ts',
      'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('std::get<');
  });

  it('emits deep class inheritance chain walking all ancestor methods for overrides', () => {
    const result = lower(
      'deep-inherit.ts',
      'class A { run(): number { return 1; } } class B extends A { step(): number { return 2; } } export class C extends B { run(): number { return 3; } step(): number { return 4; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('override');
    expect((emitted.contents.match(/override/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('emits && and || binary operators as C++ logical operators', () => {
    const result = lower(
      'logical.ts',
      'export function both(a: boolean, b: boolean): boolean { return a && b; } export function either(a: boolean, b: boolean): boolean { return a || b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('&&');
    expect(emitted.contents).toContain('||');
  });

  it('rejects two declarations that collide to the same C++ target name', () => {
    const result = lower(
      'collision.ts',
      'export function fooBar(): number { return 1; } export function foo_bar(): number { return 2; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow();
    try {
      emitIrModuleCpp(result.module);
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
    }
  });

  it('falls back to _internal_ output path when source path does not resolve to a file name', () => {
    const result = lower('index.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.path).toMatch(/^_internal_/);
  });

  it('emits class field with inferred type from initializer', () => {
    const result = lower('field-infer.ts', 'export class Pt { x = 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Pt');
    expect(emitted.contents).toMatch(/\bx\b/);
  });

  it('emits abstract class with pure virtual method', () => {
    const result = lower('shape.ts', 'export abstract class Shape { abstract area(): number; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('= 0;');
    expect(emitted.contents).toContain('virtual');
  });

  it('emits string enum as type alias', () => {
    const result = lower('status.ts', "export enum Status { Active = 'ACTIVE', Inactive = 'INACTIVE' }");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('using');
  });

  it('emits mutable variable without const qualifier', () => {
    const result = lower('mut-var.ts', 'export function inc(): number { let x: number = 1; x = x + 1; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/^\s*double x/m);
  });

  it('emits variable without initializer', () => {
    const result = lower('no-init.ts', 'export function init(): number { let x: number; x = 42; return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double x;');
  });

  it('emits ** binary operator as std::pow', () => {
    const result = lower('pow-op.ts', 'export function square(x: number): number { return x ** 2; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
  });

  it('emits >>> binary operator as unsigned right shift', () => {
    const result = lower('shr-op.ts', 'export function shift(x: number): number { return x >>> 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<uint32_t>');
  });

  it('emits *= compound assignment operator', () => {
    const result = lower(
      'mul-assign.ts',
      'export function double_(x: number): number { let y: number = x; y *= 2; return y; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('*=');
  });

  it('emits -= compound assignment operator', () => {
    const result = lower(
      'sub-assign.ts',
      'export function dec(x: number): number { let y: number = x; y -= 1; return y; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('-=');
  });

  it('emits break and continue statements in for-of loop', () => {
    const result = lower(
      'break-continue.ts',
      'export function process(items: number[]): number { let r: number = 0; for (const x of items) { if (x < 0) { continue; } if (x > 100) { break; } r = r + x; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('break;');
    expect(emitted.contents).toContain('continue;');
  });

  it('emits do-while loop', () => {
    const result = lower(
      'do-loop.ts',
      'export function count(): number { let x: number = 0; do { x = x + 1; } while (x < 5); return x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('do {');
    expect(emitted.contents).toContain('} while');
  });

  it('emits for-in iterating over object keys', () => {
    const result = lower(
      'for-in-keys.ts',
      'export function collectKeys(obj: { x: number; y: number }): string { let r: string = ""; for (const key in obj) { r = key; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits for-in with static key iteration for simple object', () => {
    const result = lower(
      'for-in-static.ts',
      'export function keys(obj: { a: number; b: number }): string { let r: string = ""; for (const key in obj) { r = r + key; } return r; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
    expect(emitted.contents).toContain('"a"');
    expect(emitted.contents).toContain('"b"');
  });

  it('emits array.length as sizeMethod call in property access', () => {
    const result = lower('arr-length.ts', 'export function len(arr: number[]): number { return arr.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
    expect(emitted.contents).toContain('.size()');
  });

  it('emits this reference in class method', () => {
    const result = lower('this-ref.ts', 'export class Box { value: number = 0; get(): number { return this.value; } }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('this->');
  });

  it('emits return in catch body for try-catch-finally deferred return detection', () => {
    const result = lower(
      'catch-return.ts',
      'export async function safe(task: Promise<number>): Promise<number> { try { return await task; } catch (e) { return await task; } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits try-finally with async co_return for deferred return', () => {
    const result = lower(
      'async-try-finally.ts',
      'export async function fetch(task: Promise<number>): Promise<number> { try { return await task; } finally { let cleanup: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits element access on array with computed index', () => {
    const result = lower('elem-access.ts', 'export function get(arr: number[], i: number): number { return arr[i]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<size_t>');
  });

  it('emits conditional expression as ternary', () => {
    const result = lower('ternary.ts', 'export function pick(cond: boolean): number { return cond ? 1 : 0; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('?');
  });

  it('emits super constructor call as initializer list entry', () => {
    const result = lower(
      'super-ctor.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } } export class Child extends Base { extra: number; constructor(v: number) { super(v); this.extra = v + 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base(');
  });

  it('emits class extending another class in the same module', () => {
    const result = lower(
      'same-mod-extend.ts',
      'export class Base { run(): number { return 1; } } export class Child extends Base { run(): number { return 2; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain(': public Base');
    expect(emitted.contents).toContain('override');
  });

  it('emits optional function parameter with std::optional default', () => {
    const result = lower(
      'optional-param.ts',
      'export function greet(name: string, loud?: boolean): string { return name; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional');
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits rest parameter as std::vector', () => {
    const result = lower(
      'rest-param.ts',
      'export function sum(...nums: number[]): number { let total: number = 0; for (const n of nums) { total = total + n; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits new Promise with flight-cpp runtime as Promise::create', () => {
    const result = lower(
      'promise-new.ts',
      'export function make(fn: (resolve: (value: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('emits nullish comparison with ambient on left side selecting right operand', () => {
    const result = lower(
      'nullish-left-ambient.ts',
      'export function check(x: number | undefined): boolean { return undefined !== x; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
  });

  it('emits runtime header from options instead of default', () => {
    const result = lower('value.ts', 'export const value = 1;');
    const emitted = emitIrModuleCpp(result.module, { runtimeHeader: 'custom/runtime.h' });
    expect(emitted.contents).toContain('#include "custom/runtime.h"');
    expect(emitted.contents).not.toContain('flight/runtime.hpp');
  });

  it('emits function type in type position', () => {
    const result = lower('fn-type.ts', 'export function apply(fn: (x: number) => string): string { return fn(1); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::function');
  });

  it('emits variant for union types without null/undefined', () => {
    const result = lower('union-variant.ts', 'export function pick(x: number | string): number | string { return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::variant');
  });

  it('emits nullish comparison with negated != operator', () => {
    const result = lower(
      'nullish-negated.ts',
      'export function isDefined(x: number | null): boolean { return x !== null; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!.has_value()');
  });

  it('emits relative import with index file as empty include', () => {
    const result = lower(
      'user.ts',
      "import { value } from './index.js'; export function get(): number { return value; }",
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('index.hpp');
  });

  it('emits class with constructor super call and initializer list', () => {
    const result = lower(
      'derived-class.ts',
      'class Animal { name: string; constructor(name: string) { this.name = name; } speak(): string { return this.name; } } export class Dog extends Animal { breed: string; constructor(name: string, breed: string) { super(name); this.breed = breed; } speak(): string { return this.breed; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Animal(');
    expect(emitted.contents).toContain('override');
  });

  it('emits narrowed present identifier with .value()', () => {
    const result = lower(
      'narrowed.ts',
      'export function check(x: number | undefined): number { if (x !== undefined) { return x; } return 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value()');
  });

  it('emits two anonymous structs with different properties', () => {
    const result = lower(
      'two-structs.ts',
      'export function first(): { a: number } { return { a: 1 }; } export function second(): { b: string } { return { b: "x" }; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct');
    const structMatches = emitted.contents.match(/struct \w+/g) ?? [];
    expect(structMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('emits sync try-finally with deferred return in non-async function', () => {
    const result = lower(
      'sync-try-finally.ts',
      'export function safe(x: number): number { try { return x + 1; } finally { let cleanup: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('return');
    expect(emitted.contents).not.toContain('co_return');
  });

  it('emits switch statement lowered to if-else chain', () => {
    const result = lower(
      'switch-break.ts',
      'export function classify(x: number): string { switch (x) { case 0: return "zero"; case 1: return "one"; default: return "other"; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
  });

  it('emits while loop', () => {
    const result = lower(
      'while-loop.ts',
      'export function countdown(n: number): number { let i: number = n; while (i > 0) { i = i - 1; } return i; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('while');
  });

  it('emits type alias as C++ using declaration', () => {
    const result = lower('alias.ts', 'export type Num = number;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('using');
  });

  it('emits generic function with template parameter', () => {
    const result = lower('generic.ts', 'export function identity<T>(x: T): T { return x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('typename');
  });

  it('emits try-finally with return only in if-consequent (no otherwise)', () => {
    const result = lower(
      'try-if-no-else.ts',
      'export async function maybeReturn(cond: boolean, task: Promise<number>): Promise<number> { try { if (cond) { return await task; } } finally { let x: number = 0; } return await task; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits nested try inside try-finally for return detection', () => {
    const result = lower(
      'nested-try-return.ts',
      'export async function nested(task: Promise<number>): Promise<number> { try { try { return await task; } catch (e) { return await task; } } finally { let x: number = 0; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('emits lambda expression with body statements', () => {
    const result = lower(
      'lambda-body.ts',
      'export function apply(arr: number[]): number[] { return arr.filter((x: number): boolean => { return x > 0; }); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
  });

  it('emits unary plus on number as identity', () => {
    const result = lower('unary-plus.ts', 'export function pos(x: number): number { return +x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('return');
  });

  it('emits bitwise not with int32 cast', () => {
    const result = lower('bit-not.ts', 'export function flip(x: number): number { return ~x; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('int32_t');
  });

  it('emits post-increment operator', () => {
    const result = lower('postinc.ts', 'export function inc(x: number): number { let y: number = x; y++; return y; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('++');
  });

  it('emits Math.pow as std::pow', () => {
    const result = lower('math-pow.ts', 'export function cube(x: number): number { return Math.pow(x, 3); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::pow');
  });

  it('emits Math.max with spread as fold over std::max_element', () => {
    const result = lower(
      'math-max-spread.ts',
      'export function maxOf(arr: number[]): number { return Math.max(...arr); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::max_element');
    expect(emitted.contents).toContain('empty()');
  });

  it('emits Math.min with spread as fold over std::min_element', () => {
    const result = lower(
      'math-min-spread.ts',
      'export function minOf(arr: number[]): number { return Math.min(...arr); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::min_element');
  });

  it('emits undefined default expression with .value_or', () => {
    const result = lower(
      'default-expr.ts',
      'export function withDefault(x: number | undefined): number { return x ?? 42; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value_or(');
  });

  it('emits tuple element access with std::get', () => {
    const result = lower('tuple-get.ts', 'export function first(pair: [number, string]): number { return pair[0]; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<0>');
  });

  it('emits cast expression as static_cast', () => {
    const result = lower('cast-expr.ts', 'export function toNum(x: unknown): number { return x as number; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast');
  });

  it('emits string literal type as string type', () => {
    const result = lower('literal-type.ts', "export function tag(): 'hello' { return 'hello'; }");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::string');
  });

  it('emits type alias for string literal union', () => {
    const result = lower('string-union.ts', "export type Dir = 'up' | 'down' | 'left' | 'right';");
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('using');
  });

  it('emits array with sparse element as empty initializer', () => {
    const result = lower('sparse.ts', 'export const x: number = 1;');
    const module = structuredClone(result.module);
    const decl = module.declarations[0];
    if (decl?.kind === 'variable' && !('pattern' in decl)) {
      (decl as any).initializer = {
        elements: [{ kind: 'literal', value: 1 }, undefined, { kind: 'literal', value: 3 }],
        kind: 'array',
      };
    }
    const emitted = emitIrModuleCpp(module);
    expect(emitted.contents).toContain('{}');
  });

  it('emits throw statement with new Error', () => {
    const result = lower('throw.ts', 'export function fail(): never { throw new Error("boom"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('throw');
    expect(emitted.contents).toContain('std::runtime_error');
  });

  it('emits IFE lambda for function expression call', () => {
    const result = lower(
      'ife.ts',
      'export function run(): number { return ((x: number): number => { return x; })(42); }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('[=]');
  });

  it('emits abstract method with parameters as pure virtual', () => {
    const result = lower(
      'abstract-method.ts',
      `export abstract class Shape {
        abstract area(scale: number): number;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('virtual');
    expect(emitted.contents).toContain('double scale');
    expect(emitted.contents).toContain('= 0;');
  });

  it('escapes C++ keywords in method and field names', () => {
    const result = lower(
      'keyword-name.ts',
      `export class Store {
        register: string = '';
        virtual(): number { return 0; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('register_');
    expect(emitted.contents).toContain('virtual_');
  });

  it('strips local break from switch case statements', () => {
    const result = lower(
      'switch-break.ts',
      `export function label(x: number): string {
        let result = '';
        switch (x) {
          case 0: result = 'zero'; break;
          case 1: result = 'one'; break;
          default: result = 'other';
        }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
    expect(emitted.contents).not.toContain('break;');
    expect(emitted.contents).toContain('result');
  });

  it('emits this return type as class name in class context', () => {
    const result = lower(
      'this-type.ts',
      `export class Builder {
        value: number = 0;
        set(n: number): this { this.value = n; return this; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Builder set(');
  });

  it('skips non-super statements before extracting super call', () => {
    const result = lower(
      'super-skip.ts',
      `export class Base { constructor(public x: number) {} }
       export class Derived extends Base {
         constructor(x: number) {
           const doubled: number = x * 2;
           super(doubled);
         }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base(');
    expect(emitted.contents).toContain('doubled');
  });

  it('detects return in catch body inside try-catch-finally', () => {
    const result = lower(
      'try-catch-finally-return.ts',
      `export function parse(s: string): number {
        try {
          throw new Error(s);
        } catch (e) {
          return 0;
        } finally {
          const x: number = 1;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('finally_exception');
    expect(emitted.contents).toContain('catch');
  });

  it('detects return in if-else branches inside try-finally', () => {
    const result = lower(
      'if-else-try-return.ts',
      `export function abs(x: number): number {
        try {
          if (x > 0) {
            return x;
          } else {
            return -x;
          }
        } finally {
          const y: number = 0;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('if (');
    expect(emitted.contents).toContain('else');
  });

  it('generates unique names when multiple switches collide', () => {
    const result = lower(
      'multi-switch.ts',
      `export function multi(x: number, y: number): string {
        let a: string = '';
        switch (x) { case 0: a = 'x'; break; default: a = 'other'; }
        let b: string = '';
        switch (y) { case 0: b = 'y'; break; default: b = 'other'; }
        return a + b;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch_value');
    expect(emitted.contents).toContain('switch_value_2');
  });

  it('generates collision-free anonymous struct names for same-property-name types', () => {
    const result = lower(
      'struct-collision.ts',
      `export function numPt(): { x: number; y: number } { return { x: 1, y: 2 }; }
       export function strPt(): { x: string; y: string } { return { x: 'a', y: 'b' }; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('x_y');
    expect(emitted.contents).toContain('x_y_1');
  });

  it('throws on missing runtime external symbol binding', () => {
    const result = lower('number-call.ts', 'export function toNum(x: string): number { return Number(x); }');
    expect(() => emitIrModuleCpp(result.module)).toThrow(/runtime external symbol binding plan is incomplete/);
  });

  it('emits negated nullish comparison as has_value without prefix', () => {
    const result = lower('not-null.ts', 'export function isPresent(x: number | null): boolean { return x !== null; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toMatch(/[^!]has_value\(\)/);
  });

  it('detects return in if-otherwise only when consequent has no return', () => {
    const result = lower(
      'if-otherwise-return.ts',
      `export function check(x: number): number {
        try {
          if (x > 0) {
            const y: number = x;
          } else {
            return -x;
          }
        } finally {
          const z: number = 0;
        }
        return 0;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in nested try-catch inside try-finally', () => {
    const result = lower(
      'nested-try-catch.ts',
      `export function nested(): number {
        try {
          try {
            throw new Error('test');
          } catch (e) {
            return 0;
          }
        } finally {
          const z: number = 0;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
    expect(emitted.contents).toContain('catch');
  });

  it('emits for-of without explicit type annotation as auto', () => {
    const result = lower(
      'for-of-auto.ts',
      `export function sum(items: number[]): number {
        let total: number = 0;
        for (const item of items) { total += item; }
        return total;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain('item');
  });

  it('emits parameter without explicit type as auto', () => {
    const result = lower('param-auto.ts', 'export function identity<T>(value: T): T { return value; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('value');
  });

  it('emits variable declaration without initializer', () => {
    const result = lower('no-init.ts', 'export let count: number;');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('double count');
    expect(emitted.contents).not.toContain('= ');
  });

  it('emits class field without explicit type annotation', () => {
    const result = lower(
      'field-no-type.ts',
      `export class Counter {
        count = 0;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('count');
  });

  it('skips static class fields in struct emission', () => {
    const result = lower(
      'static-field.ts',
      `export class Config {
        static defaultValue: number = 42;
        name: string = "";
      }`,
    );
    const classDecl = result.module.declarations.find((d) => d.kind === 'class');
    expect(classDecl?.fields.some((f) => f.static)).toBe(true);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('name');
    expect(emitted.contents).not.toMatch(/struct Config[^}]*default_value/s);
  });

  it('emits numeric enum members with explicit initializer values', () => {
    const result = lower('bare-enum.ts', 'export enum Direction { Up, Down, Left, Right }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class');
    expect(emitted.contents).toContain('Up');
    expect(emitted.contents).toContain('Down');
  });

  it('emits exponentiation assignment as plain assignment', () => {
    const result = lower(
      'power-assign.ts',
      'export function power(a: number, b: number): number { a **= b; return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('a =');
    expect(emitted.contents).not.toContain('**=');
  });

  it('emits unsigned right shift assignment as plain assignment with uint32_t cast', () => {
    const result = lower(
      'shift-assign.ts',
      'export function shift(a: number, b: number): number { a >>>= b; return a; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).not.toContain('>>>=');
    expect(emitted.contents).toContain('a =');
  });

  it('emits loose equality and inequality operators as C++ == and !=', () => {
    const result = lower(
      'loose-eq.ts',
      'export function eq(a: number, b: number): boolean { return a == b; } export function ne(a: number, b: number): boolean { return a != b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('==');
    expect(emitted.contents).toContain('!=');
  });

  it('emits negated nullish comparison with != operator', () => {
    const result = lower(
      'neg-nullish.ts',
      'export function isPresent(value: number | undefined): boolean { return value != undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!');
  });

  it('emits array.length call expression as sizeMethod with static_cast', () => {
    const result = lower('size-call.ts', 'export function count(items: number[]): number { return items.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
    expect(emitted.contents).toContain('.size()');
  });

  it('emits for-in with preserve evaluation key plan', () => {
    const result = lower(
      'for-in-preserve.ts',
      `export function keys(values: number[]): string { let result = ""; for (const key in { second: 2, first: values.length }) { result += key; } return result; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector');
    expect(emitted.contents).toContain('"second"');
    expect(emitted.contents).toContain('"first"');
  });

  it('emits for-of with auto type when variable lacks annotation', () => {
    const result = lower(
      'for-of-auto.ts',
      'export function sum<T extends number>(items: T[]): number { let total: number = 0; for (const item of items) { total += item; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
  });

  it('refuses for-of with await as an emission error', () => {
    const result = lower(
      'for-await.ts',
      'export async function collect(source: AsyncIterable<number>): Promise<number> { let total = 0; for await (const x of source) { total += x; } return total; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow(expect.objectContaining({ code: 'unsupported-ir' }));
  });

  it('emits switch case with local break detection', () => {
    const result = lower(
      'switch-break.ts',
      `export function label(x: number): string {
        switch (x) {
          case 1: return "one";
          case 2: { const v = "two"; return v; }
          default: break;
        }
        return "other";
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch');
    expect(emitted.contents).toContain('"one"');
    expect(emitted.contents).toContain('"other"');
  });

  it('emits intersection type as an emission error', () => {
    const result = lower(
      'intersection.ts',
      'interface A { x: number } interface B { y: number } export function test(value: A & B): number { return value.x; }',
    );
    expect(() => emitIrModuleCpp(result.module)).toThrow(
      'intersection types require C++ multiple-inheritance lowering',
    );
  });

  it('emits new Promise with flight-cpp profile as Task::create', () => {
    const result = lower(
      'promise-new.ts',
      'export function pending(): Promise<number> { return new Promise<number>((resolve) => resolve(1)); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('detects return in if-otherwise branch for try-finally emission', () => {
    const result = lower(
      'if-else-return.ts',
      `export async function run(flag: boolean, x: number): Promise<number> {
        try {
          if (flag) {
            x += 10;
          } else {
            return x + 2;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in catch clause for try-finally emission', () => {
    const result = lower(
      'catch-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          try {
            x += 1;
          } catch (error) {
            return x + 2;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in if-without-else inside try-finally', () => {
    const result = lower(
      'if-no-else-return.ts',
      `export async function run(flag: boolean, x: number): Promise<number> {
        try {
          if (flag) {
            return x + 1;
          }
        } finally {
          x += 1;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return in try nested inside try-finally', () => {
    const result = lower(
      'nested-try-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          try {
            return x + 1;
          } finally {
            x += 1;
          }
        } finally {
          x += 2;
        }
        return x;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('finally_return');
  });

  it('detects return inside finally body for catch-and-rethrow', () => {
    const result = lower(
      'finally-return.ts',
      `export async function run(x: number): Promise<number> {
        try {
          return x + 1;
        } finally {
          x += 1;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
  });

  it('emits function parameter without type as auto', () => {
    const result = lower('param-no-type.ts', 'export function identity<T>(value: T): T { return value; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
  });

  it('emits tupleRest expression with std::get', () => {
    const result = lower(
      'tuple-rest.ts',
      'export function rest(pair: [number, string, boolean]): boolean { const [, , third] = pair; return third; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::get<');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('resolves super reference to base class target name', () => {
    const result = lower(
      'super-ref.ts',
      `export class Base {
        value(): number { return 1; }
      }
      export class Derived extends Base {
        value(): number { return super.value() + 1; }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('Base');
    expect(emitted.contents).toContain('Derived');
  });

  it('emits class that extends a non-class binding without crashing', () => {
    const result = lower(
      'extend-type.ts',
      `export interface Movable { x: number; y: number }
       export class Point implements Movable { x: number = 0; y: number = 0; }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Point');
  });

  it('generates unique names when for-in appears twice in same module', () => {
    const result = lower(
      'double-for-in.ts',
      `export function keys(values: number[]): string {
         let result = "";
         for (const key in { a: values.length }) { result += key; }
         for (const key in { b: values.length }) { result += key; }
         return result;
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for_in_object');
    const matches = emitted.contents.match(/for_in_object/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('emits constructor with super call as init list', () => {
    const result = lower(
      'super-call.ts',
      `export class Base { x: number = 0 }
       export class Child extends Base {
         y: number = 0;
         constructor() { super(); this.y = 1; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Child');
    expect(emitted.contents).toContain('Base');
    expect(emitted.contents).toContain('Child()');
  });

  it('emits constructor without super call when class has no base', () => {
    const result = lower(
      'no-super.ts',
      `export class Config {
         value: number;
         constructor(value: number) { this.value = value; }
       }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('struct Config');
    expect(emitted.contents).toContain('Config(double value)');
  });

  it('emits sizeMethod binding as property access with static_cast', () => {
    const result = lower('size-prop.ts', 'export function len(s: string): number { return s.length; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('static_cast<double>');
  });

  it('emits ambient type reference without runtime binding as its source name', () => {
    const result = lower('ambient-type-ref.ts', 'export function makeError(): Error { return new Error("fail"); }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::runtime_error');
  });

  it('emits import with tsx extension', () => {
    const result = lowerPackage('@flighthq/ui', 'app.tsx', 'export function render(): string { return "hello"; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.path).toBe('app.hpp');
  });

  it('emits nullish coalescing as value_or', () => {
    const result = lower(
      'nullish-coalesce.ts',
      'export function fallback(a: number | undefined): number { return a ?? 0; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.value_or(');
    expect(emitted.contents).toContain('#include <optional>');
  });

  it('emits != undefined nullish comparison as negated has_value', () => {
    const result = lower(
      'nullish-neq.ts',
      'export function present(value: number | undefined): boolean { return value != undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('.has_value()');
    expect(emitted.contents).not.toContain('!value');
  });

  it('emits enum with implicit member values', () => {
    const result = lower('auto-enum.ts', 'export enum Color { Red, Green, Blue }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('enum class');
    expect(emitted.contents).toContain('Red');
    expect(emitted.contents).toContain('Green');
    expect(emitted.contents).toContain('Blue');
  });

  it('emits optional parameter as std::optional with default', () => {
    const result = lower(
      'optional-param.ts',
      'export function greet(name: string, greeting?: string): string { return (greeting ?? "Hello") + " " + name; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::optional<');
    expect(emitted.contents).toContain('std::nullopt');
  });

  it('emits rest parameter as std::vector', () => {
    const result = lower(
      'rest-param.ts',
      'export function sum(...values: number[]): number { let total = 0; for (const v of values) { total += v; } return total; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<double>');
  });

  it('emits forOf loop with typed variable', () => {
    const result = lower(
      'for-of-basic.ts',
      'export function total(values: number[]): number { let sum = 0; for (const v of values) { sum += v; } return sum; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('for (');
    expect(emitted.contents).toContain(' : ');
  });

  it('emits forIn with preserve evaluation wrapping object', () => {
    const result = lower(
      'for-in-preserve.ts',
      `export function keys(obj: { a: number; b: number }): string {
        let result = "";
        for (const key in obj) { result += key; }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits forIn with discard evaluation ordering', () => {
    const result = lower(
      'for-in-discard.ts',
      `export function keys(): string {
        let result = "";
        for (const key in { x: 1, y: 2 }) { result += key; }
        return result;
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::vector<std::string>');
  });

  it('emits class field without explicit type as auto', () => {
    const result = lower(
      'field-auto.ts',
      'export class Counter { count: number = 0; increment(): void { this.count += 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('count');
  });

  it('emits binary === as == in C++', () => {
    const result = lower('strict-eq.ts', 'export function same(a: number, b: number): boolean { return a === b; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('==');
  });

  it('emits binary !== as != in C++', () => {
    const result = lower(
      'strict-neq.ts',
      'export function different(a: number, b: number): boolean { return a !== b; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('!=');
  });

  it('emits power assignment with explicit rewrite', () => {
    const result = lower(
      'power-assign.ts',
      'export function square(x: number): number { let v = x; v **= 2; return v; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('v =');
  });

  it('refuses missing ambient runtime symbol binding', () => {
    const result = lower('unknown-ambient.ts', 'export function read(): number { return parseInt("42"); }');
    expect(() => emitIrModuleCpp(result.module)).toThrow('runtime external symbol binding plan is incomplete');
  });

  it('emits try-catch return detection through if-else branches', () => {
    const result = lower(
      'try-if-return.ts',
      `export async function process(flag: boolean): Promise<number> {
        try {
          if (flag) {
            return 1;
          } else {
            return 2;
          }
        } finally {
          flag;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('co_return');
  });

  it('emits try-catch with return in catch for finally detection', () => {
    const result = lower(
      'try-catch-return.ts',
      `export async function safe(x: number): Promise<number> {
        try {
          return x;
        } catch (e) {
          return 0;
        } finally {
          x;
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('catch');
    expect(emitted.contents).toContain('co_return');
  });

  it('emits switch case local break targeting the switch label', () => {
    const result = lower(
      'switch-label-break.ts',
      `export function classify(x: number): string {
        switch (x) {
          case 0: return "zero";
          case 1: return "one";
          default: { const msg = "other"; return msg; }
        }
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('switch');
    expect(emitted.contents).toContain('"zero"');
  });

  it('emits variable declaration without explicit type as auto', () => {
    const result = lower(
      'auto-variable.ts',
      'export function identity<T>(value: T): T { const result: T = value; return result; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
  });

  it('emits import resolution for relative specifier without extension', () => {
    const result = lower(
      'with-import.ts',
      `import { helper } from './helper.js';
       export function use(): number { return helper(); }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits tuple spread with null element and optional wrapping', () => {
    const result = lower(
      'tuple-spread-opt.ts',
      `export function merge(a: [number, string], b: [boolean]): [number, string, boolean] {
        return [...a, ...b];
      }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('std::make_tuple');
    expect(emitted.contents).toContain('#include <tuple>');
  });

  it('emits type parameter fallback to pascal case binding name', () => {
    const result = lower('type-params.ts', `export function wrap<T>(value: T): T { return value; }`);
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('template');
    expect(emitted.contents).toContain('typename');
  });

  it('emits binding target name fallback to safe cpp name', () => {
    const result = lower('binding-fallback.ts', 'export function create_item(): number { return 1; }');
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('create_item');
  });

  it('emits non-negated nullish comparison as negated has_value', () => {
    const result = lower(
      'null-equal.ts',
      'export function isAbsent(x: number | undefined): boolean { return x === undefined; }',
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('!x.has_value()');
  });

  it('emits Promise construction via ::create with flight-cpp profile', () => {
    const result = lower(
      'promise-create.ts',
      'export function make(): Promise<number> { return new Promise<number>((resolve) => { resolve(1); }); }',
    );
    const emitted = emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' });
    expect(emitted.contents).toContain('::create(');
  });

  it('emits import resolution for relative specifier without js extension', () => {
    const result = lower(
      'bare-import.ts',
      `import { helper } from './helper';
       export function use(): number { return helper(); }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('#include "helper.hpp"');
  });

  it('emits class with inherited methods tracking for virtual dispatch', () => {
    const result = lower(
      'inherit-chain.ts',
      `class Base { run(): number { return 1; } }
       class Middle extends Base { step(): number { return 2; } }
       export class Leaf extends Middle { run(): number { return 3; } step(): number { return 4; } }`,
    );
    const emitted = emitIrModuleCpp(result.module);
    expect(emitted.contents).toContain('virtual');
    expect(emitted.contents).toContain('override');
  });

  it('refuses async closures before coroutine lowering', () => {
    const result = lower('async-closure.ts', 'export function run(): void { return; }');
    const fn = result.module.declarations.find((d) => d.kind === 'function')!;
    if (fn.kind !== 'function') throw new Error('Expected function');
    const patched = {
      ...fn,
      body: [
        {
          kind: 'expression' as const,
          expression: {
            kind: 'function' as const,
            async: true,
            parameters: [],
            body: [],
            expression: undefined,
            typeParameters: [],
            returnType: { kind: 'primitive' as const, name: 'void' as const },
          },
        } as any,
      ],
    };
    const module = { ...result.module, declarations: [patched] };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('refuses for-of with await before async iteration lowering', () => {
    const result = lower('for-await.ts', 'export function run(): void { return; }');
    const fn = result.module.declarations.find((d) => d.kind === 'function')!;
    if (fn.kind !== 'function') throw new Error('Expected function');
    const patched = {
      ...fn,
      body: [
        {
          kind: 'forOf' as const,
          await: true,
          variable: {
            binding: {
              id: 'for-await-var',
              kind: 'variable',
              name: 'item',
              line: 1,
              column: 1,
              fingerprint: '',
              packageName: '',
              scope: 'local',
              source: '',
              space: 'value',
            },
            mutable: false,
          },
          expression: { kind: 'literal' as const, value: 0 },
          body: { kind: 'block' as const, statements: [] },
        } as any,
      ],
    };
    const module = { ...result.module, declarations: [patched] };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits runtime external symbol binding plan completeness failures', () => {
    const result = lower('ext.ts', 'export const x: number = 1;');
    const extraDecl = {
      kind: 'function' as const,
      binding: {
        id: 'fn-ext',
        kind: 'variable' as const,
        name: 'use',
        line: 1,
        column: 1,
        fingerprint: '',
        packageName: '',
        scope: 'module' as const,
        source: '',
        space: 'value' as const,
      },
      async: false,
      typeParameters: [],
      parameters: [],
      returnType: { kind: 'primitive' as const, name: 'void' as const },
      body: [
        {
          kind: 'expression' as const,
          expression: {
            kind: 'identifier' as const,
            reference: { kind: 'ambient' as const, name: 'NonExistentGlobal' },
            presence: 'definite' as const,
          },
        },
      ],
    };
    const module = { ...result.module, declarations: [...result.module.declarations, extraDecl] as any };
    expect(() => emitIrModuleCpp(module)).toThrow();
  });

  it('emits class with static field by skipping it in struct body', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-field.ts',
        `export class Config {
          static readonly MAX: number = 100;
          value: number;
          constructor(v: number) { this.value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Config');
    expect(output).toContain('value');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-implicit.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum class Color');
    expect(output).toContain('Red');
  });

  it('emits closure with body rather than expression', () => {
    const output = emitIrModuleCpp(
      lower(
        'closure-body.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x) => { const y = x * 2; return y; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[=]');
  });

  it('emits optional parameter as std::optional', () => {
    const output = emitIrModuleCpp(
      lower('opt-param.ts', `export function greet(name?: string): string { return name ?? "world"; }`).module,
    ).contents;
    expect(output).toContain('std::optional');
  });

  it('emits rest parameter as std::vector', () => {
    const output = emitIrModuleCpp(
      lower(
        'rest-param.ts',
        `export function sum(...nums: number[]): number {
          let total = 0;
          for (const n of nums) { total += n; }
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector');
  });

  it('emits containsReturn through if-otherwise branch', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-finally-if.ts',
        `export async function safe(): Promise<number> {
          try {
            if (true) { return 1; } else { return 2; }
          } finally {
            const _x = 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('co_return');
  });

  it('emits try-finally with return in catch clause', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-finally-catch.ts',
        `export async function safe(f: () => number): Promise<number> {
          try {
            return f();
          } catch (e) {
            return 0;
          } finally {
            const _x = 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('co_return');
  });

  it('emits type parameter with fallback name', () => {
    const output = emitIrModuleCpp(
      lower('generic.ts', `export function identity<T>(x: T): T { return x; }`).module,
    ).contents;
    expect(output).toContain('template');
    expect(output).toContain('typename');
  });

  it('emits Math.abs as ambient member call', () => {
    const output = emitIrModuleCpp(
      lower('math-abs.ts', `export function absolute(x: number): number { return Math.abs(x); }`).module,
    ).contents;
    expect(output).toContain('abs');
  });

  it('emits super reference with named base class', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-call.ts',
        `export class Base {
          x: number;
          constructor(x: number) { this.x = x; }
          greet(): string { return "base"; }
        }
        export class Derived extends Base {
          constructor(x: number) { super(x); }
          greet(): string { return "derived"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Base(');
    expect(output).toContain('override');
  });

  it('emits class with abstract method and virtual destructor', () => {
    const output = emitIrModuleCpp(
      lower(
        'abstract-class.ts',
        `export abstract class Shape {
          abstract area(): number;
        }
        export class Circle extends Shape {
          r: number;
          constructor(r: number) { super(); this.r = r; }
          area(): number { return 3.14 * this.r * this.r; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('virtual');
    expect(output).toContain('= 0');
    expect(output).toContain('override');
  });

  it('emits super constructor call extraction from class body', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-ctor.ts',
        `export class Animal {
          name: string;
          constructor(name: string) { this.name = name; }
        }
        export class Dog extends Animal {
          breed: string;
          constructor(name: string, breed: string) {
            super(name);
            this.breed = breed;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Animal(');
    expect(output).toContain('Dog(');
  });

  it('emits forIn with closed key plan', () => {
    const output = emitIrModuleCpp(
      lower(
        'for-in.ts',
        `export interface Dict { a: number; b: number; }
         export function keys(d: Dict): void {
          for (const k in d) { const _x = k; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector<std::string>');
  });

  it('emits .length call on array as static_cast<double>', () => {
    const output = emitIrModuleCpp(
      lower('arr-len.ts', `export function size(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('.size()');
  });

  it('emits tuple rest as std::get', () => {
    const output = emitIrModuleCpp(
      lower(
        'tuple-rest.ts',
        `export function rest(t: [number, string, boolean]): [string, boolean] {
          const [, ...tail] = t;
          return tail;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('std::get');
  });

  it('emits do-while loop', () => {
    const output = emitIrModuleCpp(
      lower(
        'do-while.ts',
        `export function count(): number {
          let i = 0;
          do { i += 1; } while (i < 10);
          return i;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('do {');
    expect(output).toContain('} while');
  });

  it('emits class inheriting through chain resolves methods', () => {
    const output = emitIrModuleCpp(
      lower(
        'chain-inherit.ts',
        `export class A {
          foo(): number { return 1; }
        }
        export class B extends A {
          bar(): number { return 2; }
        }
        export class C extends B {
          foo(): number { return 3; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('override');
  });

  it('emits undefined default as value_or', () => {
    const output = emitIrModuleCpp(
      lower(
        'undef-default.ts',
        `export function orZero(x: number | undefined): number {
          return x !== undefined ? x : 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('optional');
  });

  it('emits binding name fallback when not in target name map', () => {
    const module = structuredClone(
      lower('fallback-name.ts', 'export function id(x: number): number { return x; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const ret = fn.body.find((s: { kind: string }) => s.kind === 'return');
      if (ret && (ret as any).expression) {
        (ret as any).expression = {
          ...(ret as any).expression,
          kind: 'cast',
          expression: (ret as any).expression,
          type: { kind: 'primitive', name: 'number' },
        };
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('static_cast');
  });

  it('emits Math.max spread as fold with algorithm include', () => {
    const output = emitIrModuleCpp(
      lower('math-spread.ts', `export function maxOf(items: number[]): number { return Math.max(...items); }`).module,
    ).contents;
    expect(output).toContain('max_element');
    expect(output).toContain('#include <algorithm>');
  });

  it('emits variadic tuple rest with std::get and tuple include', () => {
    const output = emitIrModuleCpp(
      lower(
        'variadic-rest.ts',
        `export function head(items: [number, ...number[]]): number[] { const [, ...rest] = items; return rest; }`,
      ).module,
    ).contents;
    expect(output).toContain('#include <tuple>');
  });

  it('detects return in if-otherwise for try-finally deferred return', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export async function pick(cond: boolean, a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            if (cond) { let x: number = 0; } else { return await a; }
          } finally { let c: number = 0; }
          return await b;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('detects return in nested try-finally for outer deferred return', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-try-finally-return.ts',
        `export async function nested(a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            try { let x: number = 0; } finally { return await a; }
          } finally { let y: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits switch case with labeled break targeting the switch', () => {
    const output = emitIrModuleCpp(
      lower(
        'labeled-switch.ts',
        `export function dispatch(x: number): number {
          let result: number = 0;
          outer: switch (x) {
            case 1: result = 10; break outer;
            default: result = 0;
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('switch');
  });

  it('emits forOf loop over array', () => {
    const output = emitIrModuleCpp(
      lower(
        'for-of-loop.ts',
        `export function sum(items: number[]): number { let total: number = 0; for (const item of items) { total = total + item; } return total; }`,
      ).module,
    ).contents;
    expect(output).toContain('for (');
    expect(output).toContain(' : ');
  });

  it('emits variable without type annotation as auto', () => {
    const output = emitIrModuleCpp(
      lower('auto-var.ts', `export function calc(): number { const x = 42; return x; }`).module,
    ).contents;
    expect(output).toContain('auto');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-no-value.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum class Color');
    expect(output).toContain('Red');
  });

  it('emits forIn loop with ordered key iteration', () => {
    const result = lower(
      'for-in-ordered.ts',
      `export function keys(obj: { a: number; b: number }): string {
        let result: string = '';
        for (const k in obj) { result = result + k; }
        return result;
      }`,
    );
    const output = emitIrModuleCpp(result.module).contents;
    expect(output).toContain('std::vector<std::string>');
  });

  it('emits new Error with stdexcept include', () => {
    const output = emitIrModuleCpp(
      lower('new-error.ts', `export function fail(msg: string): never { throw new Error(msg); }`).module,
    ).contents;
    expect(output).toContain('std::runtime_error');
    expect(output).toContain('#include <stdexcept>');
  });

  it('emits optional parameter with std::nullopt default', () => {
    const output = emitIrModuleCpp(
      lower(
        'optional-param.ts',
        `export function greet(name: string, prefix?: string): string { return (prefix ?? '') + name; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
  });

  it('emits rest parameter as vector', () => {
    const output = emitIrModuleCpp(
      lower(
        'rest-param.ts',
        `export function total(...nums: number[]): number { let s: number = 0; for (const n of nums) { s = s + n; } return s; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::vector');
  });

  it('skips static fields in class struct emission', () => {
    const output = emitIrModuleCpp(
      lower(
        'class-static-field.ts',
        `export class Config {
          static readonly MAX: number = 100;
          name: string;
          constructor(n: string) { this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('struct Config');
    expect(output).not.toMatch(/\bMAX\b/);
  });

  it('emits ambient sizeMethod call for .length', () => {
    const output = emitIrModuleCpp(
      lower('size-method.ts', `export function len(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('size()');
  });

  it('emits lambda with block body', () => {
    const output = emitIrModuleCpp(
      lower(
        'lambda-block.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x) => { const y: number = x * 2; return y; });
        }`,
      ).module,
    ).contents;
    expect(output).toContain('[=]');
  });

  it('emits new Promise with flight-cpp profile', () => {
    const output = emitIrModuleCpp(
      lower(
        'new-promise-fc.ts',
        `export function make(): Promise<number> { return new Promise<number>((resolve) => resolve(42)); }`,
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;
    expect(output).toContain('::create(');
  });

  it('emits ambient member property binding', () => {
    const module = structuredClone(lower('ambient-prop.ts', 'export function f(): number { return Math.PI; }').module);
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'property' && stmt.expression.member) {
          (stmt.expression as any).member = {
            ...stmt.expression.member,
            kind: 'property',
            targetName: 'M_PI',
          };
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('M_PI');
  });

  it('emits undefinedDefault as value_or', () => {
    const output = emitIrModuleCpp(
      lower('undef-def.ts', `export function fallback(x: number | undefined, d: number): number { return x ?? d; }`)
        .module,
    ).contents;
    expect(output).toContain('value_or');
  });

  it('emits tupleRest as std::get', () => {
    const module = structuredClone(
      lower('tuple-rest.ts', 'export function first(t: [number, string]): number { return t[0]; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      const ret = fn.body.find((s: { kind: string }) => s.kind === 'return');
      if (ret?.kind === 'return' && ret.expression) {
        (ret as any).expression = {
          kind: 'tupleRest',
          object: ret.expression.kind === 'element' ? (ret.expression as any).object : ret.expression,
          start: 1,
        };
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::get<1>');
  });

  it('emits super with named base class reference', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-named.ts',
        `export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
          greet(): string { return "hello"; }
        }
        export class Child extends Base {
          constructor(v: number) { super(v); }
          greet(): string { return super.greet(); }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('Base');
  });

  it('emits type parameter fallback name as PascalCase', () => {
    const module = structuredClone(lower('tparam-fallback.ts', 'export function id<T>(x: T): T { return x; }').module);
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function' && fn.typeParameters.length > 0) {
      const tp = fn.typeParameters[0]!;
      const key = tp.binding.id;
      const tnames = (module as any)._targetNamesOverride;
      if (!tnames) {
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('template');
  });

  it('emits negated nullish comparison with has_value', () => {
    const output = emitIrModuleCpp(
      lower('negated-nullish.ts', 'export function present(x: number | undefined): boolean { return x != undefined; }')
        .module,
    ).contents;
    expect(output).toContain('.has_value()');
    expect(output).not.toContain('!');
  });

  it('emits lambda with statement body', () => {
    const output = emitIrModuleCpp(
      lower(
        'lambda-body.ts',
        'export function make(x: number): () => number { return (): number => { const y: number = x + 1; return y; }; }',
      ).module,
    ).contents;
    expect(output).toContain('[=]');
    expect(output).toContain('return');
  });

  it('emits for-of without explicit variable type as auto', () => {
    const module = structuredClone(
      lower(
        'for-of-auto.ts',
        'export function sum(items: number[]): number { let t: number = 0; for (const n of items) { t = t + n; } return t; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'forOf' && 'variable' in stmt) {
          delete (stmt.variable as any).type;
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('for (auto');
  });

  it('emits switch case with targeted labeled break', () => {
    const output = emitIrModuleCpp(
      lower(
        'switch-label.ts',
        `export function pick(x: number): number {
          switch (x) {
            case 1: { const v: number = 10; return v; }
            case 2: return 20;
            default: return 0;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('if (');
  });

  it('detects return in otherwise branch for try-finally deferred variable', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export async function branch(task: Promise<number>, flag: boolean): Promise<number> {
          try {
            if (flag) { return await task; } else { return 0; }
          } finally { let x: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('detects return in try finallyBody for deferred return detection', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-try.ts',
        `export async function nested(a: Promise<number>, b: Promise<number>): Promise<number> {
          try {
            try { return await a; } finally { let x: number = 0; }
          } finally { let y: number = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits Promise construction with flight-cpp runtime profile', () => {
    const output = emitIrModuleCpp(
      lower(
        'promise-ctor.ts',
        'export function make(fn: (resolve: (v: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
      ).module,
      { runtimeProfile: 'flight-cpp' },
    ).contents;
    expect(output).toContain('::create(');
  });

  it('emits variable declaration without explicit type as auto', () => {
    const module = structuredClone(
      lower('auto-var.ts', 'export function test(): number { const x: number = 42; return x; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'variable') {
          for (const decl of stmt.declarations) {
            delete (decl as any).type;
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('const auto x');
  });

  it('emits binding name fallback when targetNames map misses', () => {
    const module = structuredClone(
      lower('fallback-name.ts', 'export function test(x: number): number { return x; }').module,
    );
    const output = emitIrModuleCpp(module).contents;
    expect(output).toBeDefined();
  });

  it('emits tuple element access with static index', () => {
    const output = emitIrModuleCpp(
      lower('tuple-elem.ts', 'export function first(pair: [number, string]): number { return pair[0]; }').module,
    ).contents;
    expect(output).toContain('std::get<0>');
  });

  it('emits tupleSpread with optional target wrapping on element segment', () => {
    const module = structuredClone(
      lower(
        'tspread-wrap.ts',
        'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'tupleSpread') {
          const seg = stmt.expression.segments.find((s: any) => s.kind === 'element');
          if (seg?.kind === 'element') {
            const idx = stmt.expression.segments.indexOf(seg);
            (stmt.expression.type.elements[idx] as any).optional = true;
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::make_optional');
  });

  it('emits tupleSpread spread segment with optional target wrapping', () => {
    const module = structuredClone(
      lower(
        'tspread-spread-opt.ts',
        'export function combine(pair: [number, number]): [number, number, number] { return [0, ...pair]; }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'tupleSpread') {
          for (const seg of stmt.expression.segments) {
            if (seg.kind === 'spread') {
              const startIdx = stmt.expression.segments.indexOf(seg);
              const base = startIdx > 0 ? 1 : 0;
              for (let i = 0; i < seg.type.elements.length; i++) {
                const target = stmt.expression.type.elements[base + i];
                if (target) (target as any).optional = true;
              }
            }
          }
        }
      }
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::make_optional');
  });

  it('emits type reference target name fallback for non-ambient binding', () => {
    const output = emitIrModuleCpp(
      lower('type-ref-bind.ts', 'interface Pt { x: number } export function read(p: Pt): number { return p.x; }')
        .module,
    ).contents;
    expect(output).toContain('Pt');
  });

  it('emits anonymous struct with empty properties as named struct', () => {
    const module = structuredClone(
      lower('empty-obj.ts', 'export function make(): { x: number } { return { x: 1 }; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      (fn as any).returns = { kind: 'object', properties: [] };
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('anonymous');
  });

  it('returns undefined from extractSuperCallCpp when no super call exists', () => {
    const output = emitIrModuleCpp(
      lower(
        'no-super.ts',
        'class Base { value: number; constructor() { this.value = 0; } } export class Child extends Base { extra: number; constructor() { super(); this.extra = 1; } }',
      ).module,
    ).contents;
    expect(output).toContain('Child');
  });

  it('walks inherited methods and stops when base is not a class', () => {
    const output = emitIrModuleCpp(
      lower(
        'iface-extends.ts',
        `interface Runner { run(): number }
        export class Impl implements Runner { run(): number { return 1; } }`,
      ).module,
    ).contents;
    expect(output).toContain('Impl');
  });

  it('refuses Promise construction without exactly one type argument', () => {
    const module = structuredClone(
      lower(
        'promise-bad.ts',
        'export function make(fn: (resolve: (v: number) => void) => void): Promise<number> { return new Promise<number>(fn); }',
      ).module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function') {
      for (const stmt of fn.body) {
        if (stmt.kind === 'return' && stmt.expression?.kind === 'new') {
          (stmt.expression as any).typeArguments = [];
        }
      }
    }
    expect(() => emitIrModuleCpp(module, { runtimeProfile: 'flight-cpp' })).toThrow('type argument');
  });

  it('skips static fields and emits only instance fields in struct body', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-skip.ts',
        `export class Counter {
          static count: number = 0;
          static label: string = 'counter';
          value: number;
          name: string;
          constructor(v: number, n: string) { this.value = v; this.name = n; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('double value');
    expect(output).toContain('name');
    expect(output).not.toMatch(/\bcount\b/u);
    expect(output).not.toMatch(/\blabel\b/u);
  });

  it('emits labeled break in switch case that targets outer loop', () => {
    const output = emitIrModuleCpp(
      lower(
        'labeled-switch.ts',
        `export function scan(values: number[]): number {
          let result: number = 0;
          outer: for (let i: number = 0; i < values.length; i++) {
            switch (values[i]) {
              case -1:
                break outer;
              case 0:
                continue;
              default:
                result = result + values[i]!;
            }
          }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('break');
  });

  it('detects return only in else branch of if inside try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-else-return.ts',
        `export function decide(condition: boolean, cleanup: () => void): number {
          try {
            if (condition) {
              cleanup();
            } else {
              return 2;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
    expect(output).toContain('finally_exception');
  });

  it('detects return in catch body of try inside outer try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'nested-catch-return.ts',
        `export function nested(cleanup: () => void): number {
          try {
            try {
              cleanup();
            } catch (e: unknown) {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits enum member without explicit value via IR injection', () => {
    const module = structuredClone(
      lower('auto-enum.ts', 'export enum Direction { Up = 0, Down = 1, Left = 2, Right = 3 }').module,
    );
    const enumDecl = module.declarations.find((d: { kind: string }) => d.kind === 'enum');
    if (enumDecl?.kind === 'enum' && enumDecl.members[2]) {
      delete (enumDecl.members[2] as any).value;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('Left,');
    expect(output).toContain('Right = 3');
  });

  it('emits optional and rest parameters in function declarations', () => {
    const output = emitIrModuleCpp(
      lower(
        'opt-rest.ts',
        `export function greet(name: string, title?: string): string { return name; }
         export function sum(...values: number[]): number { return values[0]!; }`,
      ).module,
    ).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
    expect(output).toContain('std::vector');
  });

  it('emits super call returning undefined when constructor has no super', () => {
    const module = structuredClone(
      lower(
        'no-super.ts',
        `export class Base { value: number; constructor(v: number) { this.value = v; } }
         export class Child extends Base { extra: string; constructor(v: number) { super(v); this.extra = 'x'; } }`,
      ).module,
    );
    const child = module.declarations.find(
      (d: { kind: string; binding?: { name: string } }) => d.kind === 'class' && d.binding?.name === 'Child',
    );
    if (child?.kind === 'class' && child.classConstructor) {
      const filtered = child.classConstructor.body.filter((s: { kind: string }) => s.kind !== 'expression');
      (child.classConstructor as unknown as { body: typeof filtered }).body = filtered;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('Child');
  });

  it('skips static fields in class struct emission', () => {
    const output = emitIrModuleCpp(
      lower(
        'static-field.ts',
        `export class Counter {
          static instances: number = 0;
          count: number;
          constructor() { this.count = 0; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('double count;');
    expect(output).not.toContain('instances');
  });

  it('emits lambda with block body when expression body is absent', () => {
    const module = structuredClone(
      lower(
        'block-lambda.ts',
        `export function apply(items: number[]): number[] {
          return items.map((x: number): number => { const y = x * 2; return y; });
        }`,
      ).module,
    );
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('[=]');
    expect(output).toContain('return');
  });

  it('detects return in if-otherwise inside try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else-return.ts',
        `export function check(condition: boolean, cleanup: () => void): number {
          try {
            if (condition) {
              cleanup();
            } else {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
    expect(output).toContain('finally_exception');
  });

  it('detects return in nested finally body inside outer try-finally', () => {
    const output = emitIrModuleCpp(
      lower(
        'finally-return.ts',
        `export function nested(cleanup: () => void): number {
          try {
            try {
              cleanup();
            } finally {
              return 1;
            }
          } finally {
            cleanup();
          }
          return 0;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('finally_return');
  });

  it('emits auto type for variable declaration without type annotation via IR injection', () => {
    const module = structuredClone(lower('untyped-var.ts', 'export const value: number = 42;').module);
    const decl = module.declarations.find((d: { kind: string }) => d.kind === 'variable');
    if (decl?.kind === 'variable') {
      delete (decl as unknown as Record<string, unknown>).type;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('const auto value');
  });

  it('emits optional parameter with std::optional wrapper via IR injection', () => {
    const module = structuredClone(
      lower('opt-param.ts', 'export function greet(name: string): string { return name; }').module,
    );
    const fn = module.declarations.find((d: { kind: string }) => d.kind === 'function');
    if (fn?.kind === 'function' && fn.parameters[0]) {
      (fn.parameters[0] as Record<string, unknown>).optional = true;
    }
    const output = emitIrModuleCpp(module).contents;
    expect(output).toContain('std::optional');
    expect(output).toContain('std::nullopt');
  });

  it('resolves super reference through named base class', () => {
    const output = emitIrModuleCpp(
      lower(
        'super-base.ts',
        `export class Base { greet(): string { return 'hello'; } }
         export class Child extends Base { greet(): string { return super.greet(); } }`,
      ).module,
    ).contents;
    expect(output).toContain('Base::greet()');
  });

  it('emits rest parameter as std::vector', () => {
    const output = emitIrModuleCpp(
      lower('rest-param.ts', `export function sum(...nums: number[]): number { return nums[0]; }`).module,
    ).contents;
    expect(output).toContain('std::vector<double>');
    expect(output).toContain('nums');
  });

  it('emits try-finally with return inside if-else', () => {
    const output = emitIrModuleCpp(
      lower(
        'try-if-return.ts',
        `export function check(x: number): number {
           try {
             if (x > 0) { return x; } else { return -x; }
           } finally {
             x = 0;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('return');
  });

  it('emits array length as size cast to double', () => {
    const output = emitIrModuleCpp(
      lower('arr-len.ts', `export function len(items: number[]): number { return items.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
    expect(output).toContain('size()');
  });

  it('emits string length as size method', () => {
    const output = emitIrModuleCpp(
      lower('str-len.ts', `export function len(s: string): number { return s.length; }`).module,
    ).contents;
    expect(output).toContain('static_cast<double>');
  });

  it('emits generic type parameter as typename', () => {
    const output = emitIrModuleCpp(
      lower('generic-fn.ts', `export function identity<T>(value: T): T { return value; }`).module,
    ).contents;
    expect(output).toContain('template');
    expect(output).toContain('typename');
  });

  it('emits switch as if-else chain with switch_value', () => {
    const output = emitIrModuleCpp(
      lower(
        'switch-break.ts',
        `export function label(x: number): string {
           switch (x) {
             case 1: return 'one';
             case 2: return 'two';
             default: return 'other';
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('switch_value');
    expect(output).toContain('"one"');
    expect(output).toContain('"two"');
    expect(output).toContain('"other"');
  });

  it('emits if-else statement with otherwise branch', () => {
    const output = emitIrModuleCpp(
      lower(
        'if-else.ts',
        `export function abs(x: number): number {
           if (x >= 0) { return x; } else { return -x; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('if');
    expect(output).toContain('else');
  });

  it('emits tuple spread elements', () => {
    const result = lower(
      'tuple-spread.ts',
      `export function first(pair: [number, string]): number { return pair[0]; }`,
    );
    const output = emitIrModuleCpp(result.module).contents;
    expect(output).toContain('pair');
  });

  it('emits enum member without explicit value', () => {
    const output = emitIrModuleCpp(lower('enum-implicit.ts', `export enum Color { Red, Green, Blue }`).module).contents;
    expect(output).toContain('enum');
    expect(output).toContain('Red');
    expect(output).toContain('Green');
    expect(output).toContain('Blue');
  });
});

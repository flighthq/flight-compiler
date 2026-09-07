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

  it('refuses async functions with a coroutine lowering message', () => {
    const result = lower('fetcher.ts', 'export async function fetchData(): Promise<number> { return 1; }');

    try {
      emitIrModuleCpp(result.module);
      expect.fail('expected emission to throw');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
      expect((error as Error).message).toContain('coroutine');
    }
  });

  it('emits class inheritance with virtual destructor and initializer list', () => {
    const result = lower(
      'derived.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } doubled(): number { return this.value * 2; } } export class Derived extends Base { extra: number; constructor(v: number) { super(v); this.extra = 1; } }',
    );
    const emitted = emitIrModuleCpp(result.module);

    expect(emitted.contents).toContain('struct base {');
    expect(emitted.contents).toContain('virtual ~base() = default;');
    expect(emitted.contents).toContain('virtual double doubled()');
    expect(emitted.contents).toContain('struct derived : public base {');
    expect(emitted.contents).toContain(': base(v)');
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

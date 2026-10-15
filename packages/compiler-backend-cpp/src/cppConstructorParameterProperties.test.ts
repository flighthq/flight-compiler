import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function constructorOf(contents: string, name: string): string[] {
  const lines = contents.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  ${name}(`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line === '  }');
  return lines.slice(start, end + 1).map((line) => line.trim());
}

describe('C++ constructor parameter properties', () => {
  it('initializes the Flight InflateState parameter-property shape exactly once before its body', () => {
    const contents = emit(`class InflateState {
      bitBuffer = 0;
      bitCount = 0;
      output: Uint8Array;
      outputLength = 0;
      constructor(
        readonly input: Uint8Array,
        public position: number,
        readonly outputLimit: number,
      ) {
        this.output = new Uint8Array(outputLimit);
      }
    }`);
    const constructor = constructorOf(contents, 'InflateState');

    expect(constructor).toEqual([
      'InflateState(flight::Uint8Array input, double position, double output_limit) {',
      'this->input = input;',
      'this->position = position;',
      'this->output_limit = output_limit;',
      '(this->output = flight::Uint8Array(output_limit));',
      '}',
    ]);
    expect(constructor.filter((line) => line.startsWith('this->input = '))).toHaveLength(1);
    expect(constructor.filter((line) => line.startsWith('this->position = '))).toHaveLength(1);
    expect(constructor.filter((line) => line.startsWith('this->output_limit = '))).toHaveLength(1);
  });

  it('leaves a plain constructor parameter as a body-only value', () => {
    const contents = emit(`class Offset {
      offset = 0;
      constructor(start: number) { this.offset = start; }
    }`);

    expect(constructorOf(contents, 'Offset')).toEqual(['Offset(double start) {', '(this->offset = start);', '}']);
    expect(contents).not.toContain('this->start = start;');
  });

  it('does not initialize an explicit same-named field from a plain parameter', () => {
    const contents = emit(`class Holder {
      readonly value = 7;
      constructor(value: number) {}
    }`);

    expect(contents).toContain('double value = 7.0;');
    expect(constructorOf(contents, 'Holder')).toEqual(['Holder(double value) {', '}']);
  });

  it('preserves parameter evaluation order before parameter-property initialization', () => {
    const contents = emit(`class Defaults {
      constructor(public first: number = 1, private readonly second: number = first + 1) {}
    }`);
    const constructor = constructorOf(contents, 'Defaults');
    const firstDefault = constructor.findIndex((line) => line.startsWith('first = first.value_or('));
    const secondDefault = constructor.findIndex((line) => line.startsWith('second = second.value_or('));
    const firstProperty = constructor.indexOf('this->first = first.value();');
    const secondProperty = constructor.indexOf('this->second = second.value();');

    expect(firstDefault).toBeGreaterThan(0);
    expect(secondDefault).toBeGreaterThan(firstDefault);
    expect(firstProperty).toBeGreaterThan(secondDefault);
    expect(secondProperty).toBeGreaterThan(firstProperty);
  });

  it('initializes only the derived parameter property after the base initializer', () => {
    const contents = emit(`class Base {
      constructor(protected readonly id: number) {}
    }
    class Derived extends Base {
      constructor(id: number, private label: string) {
        super(id);
      }
    }`);

    expect(constructorOf(contents, 'Base')).toEqual(['Base(double id) {', 'this->id = id;', '}']);
    expect(constructorOf(contents, 'Derived')).toEqual([
      'Derived(double id, flight::String label) : Base(id) {',
      'this->label = label;',
      '}',
    ]);
  });

  it('leaves a later field initializer before the parameter-property body write', () => {
    const contents = emit(`class Snapshot {
      constructor(public value?: string) {}
      observed = this.value;
    }`);
    const lines = contents.split('\n');
    const observed = lines.findIndex((line) => line.includes(' observed = this->value;'));
    const valueStorage = lines.findIndex((line) => line.includes(' value;'));
    const propertyWrite = lines.findIndex((line) => line.includes('this->value = value;'));

    expect(observed).toBeGreaterThanOrEqual(0);
    expect(valueStorage).toBeGreaterThan(observed);
    expect(propertyWrite).toBeGreaterThan(valueStorage);
    expect(contents.match(/this->value = value;/gu)).toHaveLength(1);
  });
});

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile('/flight/packages/x/src/x.ts', source, ts.ScriptTarget.Latest, true);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@flighthq/x', upstreamDirectory: '/flight' });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

function captureRefusal(source: string) {
  try {
    emit(source);
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

// The declaration line of local `name` in `contents`, trimmed.
function declaration(contents: string, name: string): string {
  const line = contents.split('\n').find((candidate) => new RegExp(`\\b${name} = `, 'u').test(candidate));
  expect(line).toBeDefined();
  return line!.trim();
}

const box = 'export interface Box<T> { items: (T | null)[]; one: T }\n';
const callable = 'T extends (...args: any[]) => void';

describe('C++ constrained type-parameter union storage', () => {
  it('keeps the SDK SignalData callable parameter in its field and copied local', () => {
    const source = `
      export interface SignalData<T extends (...args: any[]) => void> {
        slots: (T | null)[];
      }
      export function emitSignalSafe<T extends (...args: any[]) => void>(data: SignalData<T>): number {
        const slots = data.slots.slice();
        return slots.length;
      }`;
    const first = emit(source);
    const second = emit(source);

    expect(first).toBe(second);
    expect(first).toContain('flight::Array<std::optional<T>> slots;');
    expect(declaration(first, 'slots')).toBe('flight::Array<std::optional<T>> slots = data->slots.slice();');
  });

  it.each([
    [
      'inferred from a copy',
      'const items = box.items.slice();',
      'flight::Array<std::optional<T>> items = box->items.slice();',
    ],
    [
      'explicitly annotated',
      'const items: (T | null)[] = box.items.slice();',
      'flight::Array<std::optional<T>> items = box->items.slice();',
    ],
    ['read directly', 'const items = box.items;', 'flight::Array<std::optional<T>> items = box->items;'],
  ])('keeps a callable-constrained parameter in an array local %s', (_, statement, expected) => {
    const contents = emit(
      `${box}export function f<${callable}>(box: Box<T>): number { ${statement} return items.length; }`,
    );
    expect(declaration(contents, 'items')).toBe(expected);
  });

  it('keeps a single object-domain constraint rather than erasing its owner', () => {
    const contents = emit(
      `${box}export function f<T extends object>(box: Box<T>): number { const items = box.items.slice(); return items.length; }`,
    );
    expect(declaration(contents, 'items')).toBe('flight::Array<std::optional<T>> items = box->items.slice();');
  });

  it('matches the unconstrained parameter, which already keeps itself', () => {
    const contents = emit(
      `${box}export function f<T>(box: Box<T>): number { const items = box.items.slice(); return items.length; }`,
    );
    expect(declaration(contents, 'items')).toBe('flight::Array<std::optional<T>> items = box->items.slice();');
  });

  it('keeps the parameter carrier after a nullable branch narrows the read', () => {
    const contents = emit(
      `export function preserve<${callable}>(value: T | null): T | null {
         if (value === null) return null;
         return value;
       }`,
    );
    expect(contents).toContain('inline std::optional<T> preserve(std::optional<T> value)');
    expect(contents).toContain('return std::optional<T>{value.value()};');
  });

  it('keeps null and undefined as distinct sentinels around the parameter carrier', () => {
    const contents = emit(
      `export interface SignalData<T extends (...args: any[]) => void> { slot: T | null | undefined }
       export function copy<${callable}>(data: SignalData<T>): T | null | undefined { return data.slot; }`,
    );
    expect(contents).toContain('std::variant<T, flight::Null, flight::Undefined> slot;');
    expect(contents).toContain(
      'inline std::variant<T, flight::Null, flight::Undefined> copy(flight::Ref<SignalData<T>> data)',
    );
    expect(contents).toContain('return data->slot;');
  });

  it('opens a multi-domain constraint instead of claiming an exact parameter owner', () => {
    const contents = emit(
      `${box}export function f<T extends string | number>(box: Box<T>): number { const items = box.items.slice(); return items.length; }`,
    );
    expect(declaration(contents, 'items')).toBe(
      'flight::Array<std::optional<std::variant<double, flight::String>>> items = box->items.slice();',
    );
  });

  it('retains the stable refusal for a multi-domain parameter value with incompatible owner arms', () => {
    const refusal = captureRefusal(
      `interface First { kind: 'first'; value: number }
       interface Second { kind: 'second'; value: string }
       type Choice = First | Second;
       export function preserve<T extends Readonly<Choice>>(value: T): T | null { return value; }`,
    );
    expect(refusal.rule).toBe('cpp-contextual-union-constrained-value-construction-unrepresented');
    expect(refusal.message).toContain('constraint does not prove which declared union owner');
  });
});

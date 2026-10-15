import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleCpp } from './cppCompilerBackend.js';

function emit(source: string): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/example/src/nullableArrayRead.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/example',
    upstreamDirectory: '/flight',
  });
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

describe('C++ length-proven nullable generic array reads', () => {
  it('keeps the exact generic owner and evaluates each slot read once', () => {
    const output = emit(`
      interface SignalData<T extends () => void> { slots: (T | null)[] }
      export function visitWhile<T extends () => void>(data: SignalData<T>): void {
        let i = 0;
        while (i < data.slots.length) {
          const slot: T | null = data.slots[i];
          if (slot === null) { i++; continue; }
          slot();
          return;
        }
      }
      export function visitFor<T extends () => void>(slots: (T | null)[]): void {
        for (let i = 0; i < slots.length; i++) {
          const slot: T | null = slots[i];
          if (slot !== null) { slot(); return; }
        }
      }
    `);

    expect(output).toContain('std::optional<T> slot = data->slots.get(i).value_or(std::nullopt);');
    expect(output).toContain('std::optional<T> slot = slots.get(i).value_or(std::nullopt);');
    expect(output.match(/(?:data->slots|slots)\.get\(i\)\.value_or\(std::nullopt\)/g)).toHaveLength(2);
    expect(output.match(/slot\.value\(\)\(\);/g)).toHaveLength(2);
    expect(output).not.toContain('std::optional<std::optional<T>> slot');
    expect(output).not.toContain('std::function<void()> slot');
  });

  it('retains the existing carrier for every unproven or distinct absence shape', () => {
    const output = emit(`
      export function unchecked<T extends () => void>(slots: (T | null)[], i: number): void {
        const uncheckedSlot: T | null = slots[i];
        if (uncheckedSlot !== null) uncheckedSlot();
      }
      export function unproven<T extends () => void>(slots: (T | null)[]): void {
        let i = 0;
        while (i <= slots.length) {
          const unprovenSlot: T | null = slots[i];
          if (unprovenSlot !== null) unprovenSlot();
          i++;
        }
      }
      export function nonNullable<T extends () => void>(slots: T[]): void {
        let i = 0;
        while (i < slots.length) {
          const requiredSlot: T = slots[i];
          if (requiredSlot !== undefined) requiredSlot();
          i++;
        }
      }
      export function dualSentinel<T extends () => void>(slots: (T | null | undefined)[]): void {
        let i = 0;
        while (i < slots.length) {
          const dualSlot: T | null | undefined = slots[i];
          if (dualSlot === undefined) { i++; continue; }
          if (dualSlot === null) { i++; continue; }
          dualSlot();
          return;
        }
      }
    `);

    expect(output).toContain('std::optional<std::optional<T>> unchecked_slot = slots.get(i);');
    expect(output).toContain('unchecked_slot.value()();');
    expect(output).toContain('std::optional<std::optional<T>> unproven_slot = slots.get(i);');
    expect(output).toContain('unproven_slot.value()();');
    expect(output).toContain('std::optional<T> required_slot = slots.get(i);');
    expect(output).toContain('required_slot.value()();');
    expect(output).toContain(
      'std::optional<std::variant<T, flight::Null, flight::Undefined>> dual_slot = slots.get(i);',
    );
    expect(output).toContain('dual_slot();');
    expect(output).not.toContain('unchecked_slot = slots.get(i).value_or');
    expect(output).not.toContain('unproven_slot = slots.get(i).value_or');
    expect(output).not.toContain('required_slot = slots.get(i).value_or');
    expect(output).not.toContain('dual_slot = slots.get(i).value_or');
  });

  it.each([
    [
      'constraint carrier',
      `export function visit<T extends () => void>(slots: (T | null)[]): void {
         let i = 0;
         while (i < slots.length) {
           const slot: (() => void) | null = slots[i];
           if (slot !== null) slot();
           i++;
         }
       }`,
    ],
    [
      'wider nullability',
      `export function visit<T extends () => void>(slots: (T | null)[]): void {
         let i = 0;
         while (i < slots.length) {
           const slot: T | null | undefined = slots[i];
           if (slot !== null && slot !== undefined) slot();
           i++;
         }
       }`,
    ],
  ])('refuses a binding that changes the element %s', (_, source) => {
    const refusal = captureRefusal(source);
    expect(refusal.rule).toBe('cpp-length-proven-nullable-generic-array-read-carrier-mismatch');
    expect(refusal.message).toContain("binding retains the element's exact owner, null sentinel, and optional payload");
  });

  it('refuses a parameter whose constraint opens to several runtime domains', () => {
    const refusal = captureRefusal(`
      export function visit<T extends string | number>(slots: (T | null)[]): void {
        let i = 0;
        while (i < slots.length) {
          const slot: T | null = slots[i];
          if (slot === null) { i++; continue; }
          return;
        }
      }
    `);

    expect(refusal.rule).toBe('cpp-length-proven-nullable-generic-array-read-multi-domain');
    expect(refusal.message).toContain('requires one exact value carrier');
  });
});

import ts from 'typescript';
import { expect, it } from 'vitest';

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

it('keeps only the nullable element carrier for length-proven generic reads', () => {
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

  expect(output).toContain('std::optional<std::function<void()>> slot = data->slots.get(i).value_or(std::nullopt);');
  expect(output).toContain('std::optional<std::function<void()>> slot = slots.get(i).value_or(std::nullopt);');
  expect(output.match(/slot\.value\(\)\(\);/g)).toHaveLength(2);
  expect(output).not.toContain('std::optional<std::optional<std::function<void()>>> slot');
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

  expect(output).toContain('std::optional<std::optional<std::function<void()>>> unchecked_slot = slots.get(i);');
  expect(output).toContain('unchecked_slot.value()();');
  expect(output).toContain('std::optional<std::optional<std::function<void()>>> unproven_slot = slots.get(i);');
  expect(output).toContain('unproven_slot.value()();');
  expect(output).toContain('std::optional<T> required_slot = slots.get(i);');
  expect(output).toContain('required_slot.value()();');
  expect(output).toContain(
    'std::optional<std::variant<std::function<void()>, flight::Null, flight::Undefined>> dual_slot = slots.get(i);',
  );
  expect(output).toContain('dual_slot();');
  expect(output).not.toContain('unchecked_slot = slots.get(i).value_or');
  expect(output).not.toContain('unproven_slot = slots.get(i).value_or');
  expect(output).not.toContain('required_slot = slots.get(i).value_or');
  expect(output).not.toContain('dual_slot = slots.get(i).value_or');
});

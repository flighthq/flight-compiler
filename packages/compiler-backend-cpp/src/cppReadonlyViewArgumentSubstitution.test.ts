import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';
import { createCppTestModuleEvaluation } from './cppModuleEvaluationTestSupport.js';

function emitReadonlyViewModules(contract: string, consumer: string): string {
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: [
      {
        specifier: '@flighthq/signals/contract',
        target: { packageName: '@flighthq/signals', source: 'packages/signals/src/contract.ts' },
      },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
  const results = lowerTypeScriptSources(
    [
      {
        packageName: '@flighthq/signals',
        sourceFile: ts.createSourceFile(
          '/flight/packages/signals/src/contract.ts',
          contract,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/power',
        sourceFile: ts.createSourceFile('/flight/packages/power/src/power.ts', consumer, ts.ScriptTarget.Latest, true),
        upstreamDirectory: '/flight',
      },
    ],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const modules = results.map((result) => result.module);
  return createCppCompilerBackend().createEmissionSession!({
    moduleEvaluation: createCppTestModuleEvaluation(modules, moduleResolution),
    moduleResolution,
    modules,
    options: { runtimeProfile: 'flight-cpp' },
  }).emitModule(modules[1]!)[0]!.contents;
}

function emitGenericReadonlyViewArgument(owner: 'Emitter' | 'Signal', argumentType: string): string {
  return emitReadonlyViewModules(
    `export interface Signal<T extends (...args: any[]) => void> { emit: T; data: object | null }
     export interface Emitter<T extends (...args: any[]) => void> { emit: T; data: object | null }
     export function hasSignalSlots<T extends (...args: any[]) => void>(
       signal: Readonly<Signal<T>>,
     ): boolean {
       return signal.data !== null;
     }`,
    `import { hasSignalSlots } from '@flighthq/signals/contract';
     import type { ${owner} } from '@flighthq/signals/contract';
     export function pollIdle(onIdleStateChange: ${argumentType} | null): boolean {
       if (onIdleStateChange === null || !hasSignalSlots(onIdleStateChange)) return false;
       return true;
     }
     export function pollIdleProperty(host: { onIdleStateChange: ${argumentType} | null }): boolean {
       const idleSignal = host.onIdleStateChange;
       if (idleSignal === null || !hasSignalSlots(idleSignal)) return false;
       return true;
     }`,
  );
}

describe('readonly-view argument substitution', () => {
  it('substitutes a generic callable parameter through the readonly view', () => {
    const output = emitGenericReadonlyViewArgument('Signal', 'Signal<() => void>');

    expect(output).toContain(
      'flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<flighthq_signals::Signal<std::function<void()>>>>>>',
    );
    expect(output.split('flighthq_signals::has_signal_slots<std::function<void()>>')).toHaveLength(3);
    expect(output).not.toContain('Signal<T>');
    expect(output).not.toContain('flight::make_ref');
    expect(output).not.toContain('flight::materialize_row');
  });

  it('does not substitute a callable from an incompatible owner', () => {
    const output = emitGenericReadonlyViewArgument('Emitter', 'Emitter<() => void>');

    expect(output).toContain('flighthq_signals::Emitter<std::function<void()>>');
    expect(output).not.toContain('Signal<std::function<void()>>');
  });

  it('substitutes when the argument is already a readonly view of the same owner', () => {
    const output = emitGenericReadonlyViewArgument('Signal', 'Readonly<Signal<() => void>>');

    expect(output.split('flighthq_signals::has_signal_slots<std::function<void()>>')).toHaveLength(3);
    expect(output).not.toContain('Signal<T>');
  });

  it('keeps qualification and evaluates a callable argument once', () => {
    const output = emitReadonlyViewModules(
      `export interface Event { readonly kind: string }
       export interface Signal<T extends (...args: any[]) => void> { emit: T; data: object | null }
       export function hasSignalSlots<T extends (...args: any[]) => void>(signal: Readonly<Signal<T>>): boolean {
         return signal.data !== null;
       }`,
      `import { hasSignalSlots } from '@flighthq/signals/contract';
       import type { Event, Signal } from '@flighthq/signals/contract';
       function current(signal: Signal<(event: Event) => void>): Signal<(event: Event) => void> { return signal; }
       export function poll(signal: Signal<(event: Event) => void>): boolean {
         return hasSignalSlots(current(signal));
       }`,
    );

    expect(output).toContain(
      'flighthq_signals::has_signal_slots<std::function<void(flight::Ref<flighthq_signals::Event>)>>',
    );
    expect(output.match(/current\(signal\)/gu)).toHaveLength(1);
    expect(output).not.toContain('flight::make_ref');
    expect(output).not.toContain('flight::materialize_row');
  });

  it('retains the writable-view refusal after substitution', () => {
    const output = emitReadonlyViewModules(
      `export interface Signal<T extends (...args: any[]) => void> { emit: T; data: object | null }
       export function mutateSignal<T extends (...args: any[]) => void>(signal: Signal<T>, listener: T): boolean {
         signal.data = null;
         signal.emit = listener;
         return true;
       }`,
      `import { mutateSignal } from '@flighthq/signals/contract';
       import type { Signal } from '@flighthq/signals/contract';
       export function poll(signal: Readonly<Signal<() => void>>): boolean { return mutateSignal(signal, () => {}); }`,
    );

    // The source capability outranks the checker-instantiated writable parameter spelling. Leaving
    // deduction implicit preserves the call's existing refusal instead of manufacturing write access.
    expect(output).toContain('flighthq_signals::mutate_signal(signal,');
    expect(output).not.toContain('mutate_signal<std::function<void()>>');
  });

  it('retains the ambiguous multi-owner view refusal', () => {
    const output = emitReadonlyViewModules(
      `export interface Signal<T extends (...args: any[]) => void> { emit: T; data: object | null }
       export interface Emitter<T extends (...args: any[]) => void> { emit: T; data: object | null }
       export function hasSignalSlots<T extends (...args: any[]) => void>(signal: Readonly<Signal<T>>): boolean {
         return signal.data !== null;
       }`,
      `import { hasSignalSlots } from '@flighthq/signals/contract';
       import type { Emitter, Signal } from '@flighthq/signals/contract';
       export function poll(signal: Signal<() => void> | Emitter<() => void>): boolean {
         return hasSignalSlots(signal);
       }`,
    );

    // Neither nominal owner is uniquely selected, so the substitution remains absent.
    expect(output).toContain('flighthq_signals::has_signal_slots(signal)');
    expect(output).not.toContain('has_signal_slots<std::function<void()>>');
  });
});

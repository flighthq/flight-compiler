import { describe, expect, it } from 'vitest';

import ts from 'typescript';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

function emitGenericReadonlyViewArgument(owner: 'Emitter' | 'Signal', argumentType: string): string {
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
          `export interface Signal<T extends (...args: any[]) => void> { emit: T; data: object | null }
           export interface Emitter<T extends (...args: any[]) => void> { emit: T; data: object | null }
           export function hasSignalSlots<T extends (...args: any[]) => void>(
             signal: Readonly<Signal<T>>,
           ): boolean {
             return signal.data !== null;
           }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/power',
        sourceFile: ts.createSourceFile(
          '/flight/packages/power/src/power.ts',
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
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const modules = results.map((result) => result.module);
  return createCppCompilerBackend().createEmissionSession!({
    moduleResolution,
    modules,
    options: { runtimeProfile: 'flight-cpp' },
  }).emitModule(modules[1]!)[0]!.contents;
}

describe('readonly-view argument substitution', () => {
  it('substitutes a generic callable parameter through the readonly view', () => {
    const output = emitGenericReadonlyViewArgument('Signal', 'Signal<() => void>');

    expect(output).toContain(
      'flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<flighthq_signals::Signal<std::function<void()>>>>>>',
    );
    expect(output.split('flighthq_signals::has_signal_slots<std::function<void()>>')).toHaveLength(3);
    expect(output).not.toContain('Signal<T>');
  });

  it('does not substitute a callable from an incompatible owner', () => {
    const output = emitGenericReadonlyViewArgument('Emitter', 'Emitter<() => void>');

    expect(output).toContain('flighthq_signals::Emitter<std::function<void()>>');
    expect(output).not.toContain('Signal<std::function<void()>>');
  });
});

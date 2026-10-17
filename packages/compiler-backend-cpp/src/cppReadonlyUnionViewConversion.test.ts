import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend, emitIrModuleCpp } from './cppCompilerBackend.js';

function captureRefusal(source: string) {
  try {
    emit(source);
  } catch (error) {
    if (isBackendEmissionFailure(error)) return error;
    throw error;
  }
  throw new Error('expected C++ emission to refuse and it did not');
}

function emit(source: string): string {
  const sourceFile = ts.createSourceFile(
    '/flight/packages/math/src/readonly-union-views.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
  expect(result.diagnostics).toEqual([]);
  return emitIrModuleCpp(result.module, { runtimeProfile: 'flight-cpp' }).contents;
}

describe('nominal union to readonly structural-view union conversion', () => {
  it('converts every nominal arm to its exact reordered view and evaluates the source once', () => {
    const contents = emit(
      `interface Base { kind: string }
       interface First extends Base { first: number }
       interface Second extends Base { second: number }
       type Value = Base | First | Second;
       type ReadonlyValue = Readonly<Second> | Readonly<Base> | Readonly<First>;
       function current(value: Value): Value { return value; }
       function read(value: ReadonlyValue): string { return value.kind; }
       export function readMutable(value: Value): string { return read(current(value)); }`,
    );

    expect(contents).toContain('std::visit');
    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<Base>>');
    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<First>>');
    expect(contents).toContain('flight::StructuralRef<flight::RowReadonly<flight::RowOf<flight::Ref<Second>>>>');
    expect(contents).toMatch(
      /std::is_same_v<contextual_union_value_type, flight::Ref<First>>[^}]+RowOf<flight::Ref<First>>/u,
    );
    expect(contents.match(/current\(value\)/gu)).toHaveLength(1);
    expect(contents).not.toContain('flight::materialize_row');
    expect(contents).not.toContain('shared_exact_object');
  });

  it('uses a unique proven widening and permits unused destination arms', () => {
    const contents = emit(
      `interface Concrete { common: number; hidden: boolean }
       interface View { common: number }
       interface Other { kind: 'other' }
       interface Unused { kind: 'unused' }
       type Value = Concrete | Other;
       type ReadonlyValue = Readonly<View> | Readonly<Other> | Readonly<Unused>;
       function read(value: ReadonlyValue): number { return 'common' in value ? value.common : 0; }
       export function readMutable(value: Value): number { return read(value); }`,
    );

    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<Concrete>>');
    expect(contents).toContain('flight::RowOf<flight::Ref<View>>');
    expect(contents).toContain('flight::RowOf<flight::Ref<Unused>>');
  });

  it('keeps imported source owners and destination rows qualified', () => {
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const results = lowerTypeScriptSources(
      [
        {
          packageName: '@flighthq/types',
          sourceFile: ts.createSourceFile(
            '/flight/packages/types/src/contract.ts',
            `export interface Base { kind: string }
             export interface First extends Base { first: number }
             export interface Second extends Base { second: number }
             export type Value = Base | First | Second;
             export type ReadonlyValue = Readonly<Second> | Readonly<Base> | Readonly<First>;`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
        {
          packageName: '@flighthq/consumer',
          sourceFile: ts.createSourceFile(
            '/flight/packages/consumer/src/consumer.ts',
            `import type { ReadonlyValue, Value } from '@flighthq/types/contract';
             function read(value: ReadonlyValue): string { return value.kind; }
             export function readMutable(value: Value): string { return read(value); }`,
            ts.ScriptTarget.Latest,
            true,
          ),
          upstreamDirectory: '/flight',
        },
      ],
      moduleResolution,
    );
    const modules = results.map((result) => result.module);
    const contents = createCppCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules,
      options: {
        packageTargets: {
          '@flighthq/consumer': { includePrefix: 'flight/consumer', namespace: 'flight::consumer' },
          '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
        },
        runtimeProfile: 'flight-cpp',
      },
    }).emitModule(modules[1]!)[0]!.contents;

    expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(contents).toContain('std::is_same_v<contextual_union_value_type, flight::Ref<flight::types::First>>');
    expect(contents).toContain('flight::RowOf<flight::Ref<flight::types::First>>');
    expect(contents).not.toContain('flight::Ref<First>');
  });

  it('refuses ambiguous, writable, mixed-carrier, and inequivalent mappings', () => {
    const ambiguous = captureRefusal(
      `interface Concrete { common: number; left: number; right: number; hidden: boolean }
       interface LeftView { common: number; left: number }
       interface RightView { common: number; right: number }
       interface Other { kind: 'other' }
       type Value = Concrete | Other;
       type Views = Readonly<LeftView> | Readonly<RightView> | Readonly<Other>;
       function read(_value: Views): void {}
       export function test(value: Value): void { read(value); }`,
    );
    const writable = captureRefusal(
      `interface Concrete { kind: 'exact'; value: number; hidden: boolean }
       type WritableView = Omit<Concrete, 'hidden'>;
       interface Other { kind: 'other'; value: number }
       type Value = Concrete | Other;
       type Views = WritableView | Readonly<Other>;
       function read(_value: Views): void {}
       export function test(value: Value): void { read(value); }`,
    );
    const sharedDestination = captureRefusal(
      `interface Left { common: number; left: boolean }
       interface Right { common: number; right: boolean }
       interface View { common: number }
       interface Other { kind: 'other' }
       type Value = Left | Right;
       type Views = Readonly<View> | Readonly<Other>;
       function read(_value: Views): void {}
       export function test(value: Value): void { read(value); }`,
    );
    const mixedCarrier = captureRefusal(
      `interface Concrete { common: number; hidden: boolean }
       interface View { common: number }
       interface Other { kind: 'other' }
       type Value = Readonly<Concrete> | Other;
       type Views = Readonly<View> | Readonly<Other>;
       function read(_value: Views): void {}
       export function test(value: Value): void { read(value); }`,
    );
    const inequivalent = captureRefusal(
      `interface Concrete { value: any; hidden: boolean }
       interface View { value: number }
       interface Other { kind: 'other' }
       type Value = Concrete | Other;
       type Views = Readonly<View> | Readonly<Other>;
       function read(_value: Views): void {}
       export function test(value: Value): void { read(value); }`,
    );

    for (const refusal of [ambiguous, writable, sharedDestination, mixedCarrier, inequivalent]) {
      expect(refusal.rule).toBe('cpp-contextual-union-inequivalent');
    }
  });
});

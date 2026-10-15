import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerCppCAbiPlanningOptions, IrModule } from '../../compiler-types/src/index.js';
import { createIrModulesCAbiPlanCpp } from './cppCAbiPlan.js';

const geometryTarget = {
  packageTargets: {
    '@flight/geometry': { includePrefix: 'flight/geometry', namespace: 'flight::geometry' },
  },
} as const satisfies CompilerCppCAbiPlanningOptions;

describe('createIrModulesCAbiPlanCpp', () => {
  it('plans scalar functions and source out-parameter functions under ABI v1 policy', () => {
    const module = lower(
      'geometry.ts',
      `
        export interface Point { x: number; y: number; }
        export function add(left: number, right: number): number { return left + right; }
        export function translate(target: Point, dx: number): void { target.x += dx; }
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.policy).toEqual({
      error: 'status-plus-initialized-out-result',
      exportPrefix: 'flight_cpp_',
      lastError: 'none',
      lifecycle: 'type-specific-retain-release',
      records: 'explicit-member-presence-flags',
      references: 'incomplete-c-struct-pointers',
      visibility: 'FLIGHT_CPP_API',
    });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.functions).toEqual([
      expect.objectContaining({
        cppTarget: 'flight::geometry::add',
        error: expect.objectContaining({
          initializesOutResultBeforeValidation: true,
          lastError: 'none',
          statusCarrier: 'flight_cpp_status',
          strategy: 'status-return',
        }),
        header: 'flight/geometry.h',
        parameters: [
          {
            adapter: 'copy-scalar-from-c',
            carrier: 'double',
            name: 'left',
            ownership: 'value',
            position: 0,
            presence: 'required',
          },
          {
            adapter: 'copy-scalar-from-c',
            carrier: 'double',
            name: 'right',
            ownership: 'value',
            position: 1,
            presence: 'required',
          },
        ],
        result: {
          adapter: 'copy-scalar-to-out',
          carrier: 'double*',
          initialization: 'zero',
          kind: 'out',
          name: 'out_result',
          ownership: 'value',
          presence: 'required',
        },
        sourceName: 'add',
        symbol: 'flight_cpp_add',
      }),
      expect.objectContaining({
        cppTarget: 'flight::geometry::translate',
        parameters: [
          {
            adapter: 'borrow-handle',
            carrier: 'struct flight_cpp_point*',
            handleCarrier: 'flight_cpp_point',
            name: 'target',
            ownership: 'borrowed',
            position: 0,
            presence: 'required',
          },
          expect.objectContaining({ carrier: 'double', name: 'dx' }),
        ],
        result: { adapter: 'none', kind: 'void', ownership: 'none', presence: 'not-applicable' },
        symbol: 'flight_cpp_translate',
      }),
    ]);
  });

  it('plans explicit presence fields for Partial and optional scalar records', () => {
    const module = lower(
      'options.ts',
      `
        interface Options { sampleCount: number; enabled: boolean; }
        export function apply(options: Partial<Options>): void { void options; }
        export function snapshot(): { sampleCount?: number; enabled?: boolean } { return {}; }
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.diagnostics).toEqual([]);
    expect(plan.records).toEqual([
      expect.objectContaining({
        carrier: 'flight_cpp_apply_options_record',
        construction: 'flight-reference-designated-optional-aggregate',
        members: [
          {
            carrier: 'double',
            cppName: 'sample_count',
            hasName: 'has_sample_count',
            initialization: '0.0',
            name: 'sample_count',
            position: 0,
            presence: 'explicit-flag',
            sourceName: 'sampleCount',
          },
          {
            carrier: 'bool',
            cppName: 'enabled',
            hasName: 'has_enabled',
            initialization: 'false',
            name: 'enabled',
            position: 1,
            presence: 'explicit-flag',
            sourceName: 'enabled',
          },
        ],
        passing: 'borrowed-const-pointer',
        sourceName: 'apply.options',
      }),
      expect.objectContaining({
        carrier: 'flight_cpp_snapshot_result_record',
        sourceName: 'snapshot.result',
      }),
    ]);
    expect(plan.functions).toEqual([
      expect.objectContaining({
        parameters: [
          expect.objectContaining({
            adapter: 'copy-record-from-c',
            carrier: 'const struct flight_cpp_apply_options_record*',
            recordCarrier: 'flight_cpp_apply_options_record',
          }),
        ],
        symbol: 'flight_cpp_apply',
      }),
      expect.objectContaining({
        result: expect.objectContaining({
          adapter: 'copy-record-to-out',
          carrier: 'struct flight_cpp_snapshot_result_record*',
          initialization: 'record-zero',
          recordCarrier: 'flight_cpp_snapshot_result_record',
        }),
        symbol: 'flight_cpp_snapshot',
      }),
    ]);
  });

  it('preserves one nullable pointer sentinel and refuses an optional record member with two sentinels', () => {
    const module = lower(
      'presence.ts',
      `
        export interface Point { x: number; }
        export function accept(point: Point | null): void { void point; }
        export function configure(options: { point?: Point | null }): void { void options; }
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.functions).toEqual([
      expect.objectContaining({
        parameters: [expect.objectContaining({ carrier: 'struct flight_cpp_point*', presence: 'nullable-null' })],
        symbol: 'flight_cpp_accept',
      }),
    ]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: 'dual-sentinel-union', sourceName: 'configure' }),
    ]);
  });

  it('refuses normalized record field and generated-presence collisions deterministically', () => {
    const module = lower(
      'collisions.ts',
      `
        export function normalized(options: { sampleCount?: number; sample_count?: number }): void {}
        export function presence(options: { active?: boolean; hasActive?: boolean }): void {}
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.functions).toEqual([]);
    expect(plan.records).toEqual([]);
    expect(plan.diagnostics.map(({ code, sourceName }) => ({ code, sourceName }))).toEqual([
      { code: 'record-member-collision', sourceName: 'presence' },
      { code: 'record-member-collision', sourceName: 'normalized' },
    ]);
  });

  it('plans opaque references, readonly borrows, nullable references, and type-specific lifecycle', () => {
    const module = lower(
      'point.ts',
      `
        export interface Point { x: number; y: number; }
        export function clonePoint(source: Readonly<Point>): Point { return { x: source.x, y: source.y }; }
        export function findPoint(source: Point | null): Point | undefined { return source ?? undefined; }
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.diagnostics).toEqual([]);
    expect(plan.handles).toEqual([
      expect.objectContaining({
        borrowSymbol: 'flight_cpp_point_borrow_owner',
        carrier: 'flight_cpp_point',
        cppOwnerCarrier: 'flight::Ref<flight::geometry::Point>',
        cppTarget: 'flight::geometry::Point',
        createOwnedSymbol: 'flight_cpp_point_create_owned',
        header: 'flight/geometry.h',
        lifecycle: {
          borrowedInput: 'const-owner-reference',
          counter: 'atomic-wrapper-reference-count',
          initialReferences: 1,
          nullOwnedOutput: 'null-handle',
          nullRelease: 'no-op',
          nullRetain: 'return-null',
          ownedOutput: 'move-owner-into-new-wrapper',
          retainedResult: 'same-handle',
          zeroReferences: 'delete-wrapper',
        },
        ownership: 'opaque-reference',
        packageName: '@flight/geometry',
        releaseSymbol: 'flight_cpp_point_release',
        retainSymbol: 'flight_cpp_point_retain',
        sourceName: 'Point',
      }),
    ]);
    expect(plan.functions).toEqual([
      expect.objectContaining({
        parameters: [
          expect.objectContaining({
            adapter: 'borrow-readonly-handle',
            carrier: 'const struct flight_cpp_point*',
            handleCarrier: 'flight_cpp_point',
            presence: 'required',
          }),
        ],
        result: expect.objectContaining({
          adapter: 'create-owned-handle-to-out',
          carrier: 'struct flight_cpp_point**',
          handleCarrier: 'flight_cpp_point',
          initialization: 'null',
          ownership: 'owned',
          presence: 'required',
        }),
        symbol: 'flight_cpp_clone_point',
      }),
      expect.objectContaining({
        parameters: [expect.objectContaining({ carrier: 'struct flight_cpp_point*', presence: 'nullable-null' })],
        result: expect.objectContaining({ carrier: 'struct flight_cpp_point**', presence: 'nullable-undefined' }),
        symbol: 'flight_cpp_find_point',
      }),
    ]);
  });

  it('refuses dual sentinels and other unsupported surfaces with stable target-owned diagnostics', () => {
    const module = lower(
      'unsupported.ts',
      `
        export interface Point { x: number; }
        export interface Dictionary { [key: string]: number; }
        export function dual(value: Point | null | undefined): Point { return value!; }
        export function generic<Value>(value: Value): Value { return value; }
        export function invoke(callback: (value: number) => number): number { return callback(1); }
        export function lookup(value: Dictionary): number { return value.answer ?? 0; }
        export function overloaded(value: number): number;
        export function overloaded(value: boolean): boolean;
        export function overloaded(value: number | boolean): number | boolean { return value; }
      `,
    );

    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);

    expect(plan.functions).toEqual([]);
    expect(
      plan.diagnostics.map(({ classification, code, sourceName, target }) => ({
        classification,
        code,
        sourceName,
        target,
      })),
    ).toEqual([
      { classification: 'compiler-restriction', code: 'dual-sentinel-union', sourceName: 'dual', target: 'cpp' },
      { classification: 'compiler-restriction', code: 'generic-surface', sourceName: 'generic', target: 'cpp' },
      { classification: 'compiler-restriction', code: 'callable-value', sourceName: 'invoke', target: 'cpp' },
      { classification: 'compiler-restriction', code: 'open-structural-type', sourceName: 'lookup', target: 'cpp' },
      {
        classification: 'compiler-restriction',
        code: 'overloaded-function',
        sourceName: 'overloaded',
        target: 'cpp',
      },
    ]);
  });

  it('refuses ambiguous imported owners instead of selecting a carrier', () => {
    const first = lower('first.ts', 'export interface Point { x: number; }', '@flight/shared');
    const second = lower('second.ts', 'export interface Point { y: number; }', '@flight/shared');
    const shared = lower('index.ts', "export * from './first'; export * from './second';", '@flight/shared');
    const consumer = lower(
      'consumer.ts',
      "import type { Point } from '@flight/shared'; export function usePoint(value: Point): void {}",
      '@flight/consumer',
    );
    const plan = createIrModulesCAbiPlanCpp([first, consumer, shared, second], {
      moduleResolution: {
        edges: [
          { specifier: '@flight/shared', target: { packageName: shared.packageName, source: shared.source } },
          {
            importer: { name: shared.name, packageName: shared.packageName, source: shared.source },
            specifier: './first',
            target: { packageName: first.packageName, source: first.source },
          },
          {
            importer: { name: shared.name, packageName: shared.packageName, source: shared.source },
            specifier: './second',
            target: { packageName: second.packageName, source: second.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
    });

    expect(plan.functions).toEqual([]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: 'ambiguous-owner', sourceName: 'usePoint', target: 'cpp' }),
    ]);
  });

  it('refuses flat global C symbol collisions across packages', () => {
    const geometry = lower(
      'geometry.ts',
      'export function create(value: number): number { return value; }',
      '@flight/geometry',
    );
    const image = lower(
      'image.ts',
      'export function create(value: boolean): boolean { return value; }',
      '@flight/image',
    );

    const plan = createIrModulesCAbiPlanCpp([geometry, image]);

    expect(plan.functions).toEqual([]);
    expect(plan.diagnostics.map(({ code, packageName, sourceName }) => ({ code, packageName, sourceName }))).toEqual([
      { code: 'global-symbol-collision', packageName: '@flight/geometry', sourceName: 'create' },
      { code: 'global-symbol-collision', packageName: '@flight/image', sourceName: 'create' },
    ]);
  });

  it('is deterministic under module reordering and does not mutate inputs', () => {
    const geometry = lower(
      'geometry.ts',
      'export interface Point { x: number; } export function makePoint(): Point { return { x: 1 }; } export function configure(options: { count?: number; enabled?: boolean }): void {}',
    );
    const scalar = lower('scalar.ts', 'export function negate(value: boolean): boolean { return !value; }');
    const modules = [geometry, scalar];
    const options = structuredClone(geometryTarget);
    const modulesBefore = structuredClone(modules);
    const optionsBefore = structuredClone(options);

    const forward = createIrModulesCAbiPlanCpp(modules, options);
    const reverse = createIrModulesCAbiPlanCpp([...modules].reverse(), options);

    expect(reverse).toEqual(forward);
    expect(modules).toEqual(modulesBefore);
    expect(options).toEqual(optionsBefore);
  });

  it('keeps all planned carriers valid C spellings without C++ syntax', () => {
    const module = lower(
      'carriers.ts',
      `
        export interface Point { x: number; }
        export function inspect(point: Readonly<Point>, enabled: boolean): Point | null {
          return enabled ? { x: point.x } : null;
        }
      `,
    );
    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);
    const carriers = [
      ...plan.handles.map((handle) => handle.carrier),
      ...plan.functions.flatMap((fn) => fn.parameters.map((parameter) => parameter.carrier)),
      ...plan.functions.flatMap((fn) => (fn.result.kind === 'out' ? [fn.result.carrier] : [])),
      ...plan.functions.map((fn) => fn.error.statusCarrier),
    ];

    expect(carriers).not.toEqual([]);
    expect(carriers).toSatisfy((values: readonly string[]) =>
      values.every((carrier) => !/::|[<>&]|\bstd\b|\bflight::/u.test(carrier)),
    );
  });
});

function lower(file: string, source: string, packageName = '@flight/geometry'): IrModule {
  const sourceFile = ts.createSourceFile(`/flight/packages/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '/flight' }).module;
}

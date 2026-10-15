import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerCppCAbiEmissionFailure, CompilerCppCAbiPlan, IrModule } from '../../compiler-types/src/index.js';
import {
  emitCompilerCppCAbiPackage,
  emitCompilerCppCAbiPlan,
  isCompilerCppCAbiEmissionFailure,
} from './cppCAbiEmission.js';
import { createIrModulesCAbiPlanCpp } from './cppCAbiPlan.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

const geometryTarget = {
  packageTargets: {
    '@flight/geometry': { includePrefix: 'flight/geometry', namespace: 'flight::geometry' },
  },
} as const;

describe('emitCompilerCppCAbiPlan', () => {
  it('emits a self-contained C11 declaration and exact scalar C++ adapter definition', () => {
    const plan = createPlan(
      `
        export function add(left: number, right: number): number { return left + right; }
      `,
    );

    const emission = emitCompilerCppCAbiPlan(plan);

    expect(emission).toEqual({
      functions: [
        {
          adapterSourceContents: `#include <flight/geometry/geometry.hpp>

extern "C" FLIGHT_CPP_API flight_cpp_status flight_cpp_add(double left, double right, double* out_result) {
  if (out_result != nullptr) {
    *out_result = 0.0;
  }
  if (out_result == nullptr) {
    return FLIGHT_CPP_STATUS_INVALID_ARGUMENT;
  }
  try {
    *out_result = flight::geometry::add(left, right);
    return FLIGHT_CPP_STATUS_OK;
  } catch (...) {
    return FLIGHT_CPP_STATUS_EXCEPTION;
  }
}
`,
          bindingId: plan.functions[0]?.bindingId,
          headerContents: `#ifndef FLIGHT_CPP_C_ABI_FLIGHT_CPP_ADD_H
#define FLIGHT_CPP_C_ABI_FLIGHT_CPP_ADD_H

#include <stdbool.h>

#ifndef FLIGHT_CPP_API
#if defined(_WIN32)
#if defined(FLIGHT_CPP_BUILD)
#define FLIGHT_CPP_API __declspec(dllexport)
#else
#define FLIGHT_CPP_API __declspec(dllimport)
#endif
#elif defined(__GNUC__)
#define FLIGHT_CPP_API __attribute__((visibility("default")))
#else
#define FLIGHT_CPP_API
#endif
#endif

#ifndef FLIGHT_CPP_ABI_V1_STATUS_DEFINED
#define FLIGHT_CPP_ABI_V1_STATUS_DEFINED
typedef enum flight_cpp_status {
  FLIGHT_CPP_STATUS_OK = 0,
  FLIGHT_CPP_STATUS_INVALID_ARGUMENT = 1,
  FLIGHT_CPP_STATUS_EXCEPTION = 2
} flight_cpp_status;
#endif

#if defined(__cplusplus)
extern "C" {
#endif

FLIGHT_CPP_API flight_cpp_status flight_cpp_add(double left, double right, double* out_result);

#if defined(__cplusplus)
}
#endif

#endif /* FLIGHT_CPP_C_ABI_FLIGHT_CPP_ADD_H */
`,
          headerPath: 'flight/geometry/geometry.hpp',
          packageName: '@flight/geometry',
          source: plan.functions[0]?.source,
          symbol: 'flight_cpp_add',
        },
      ],
      handles: [],
      records: [],
      schema: 'flight-compiler-cpp-c-abi-emission/1',
    });
  });

  it('emits void and boolean functions without inventing non-scalar conversion', () => {
    const plan = createPlan(
      `
        export function ready(): boolean { return true; }
        export function setEnabled(enabled: boolean): void { void enabled; }
      `,
    );

    const emission = emitCompilerCppCAbiPlan(plan);
    const ready = emission.functions.find((item) => item.symbol === 'flight_cpp_ready');
    const setEnabled = emission.functions.find((item) => item.symbol === 'flight_cpp_set_enabled');

    expect(ready?.headerContents).toContain('FLIGHT_CPP_API flight_cpp_status flight_cpp_ready(bool* out_result);');
    expect(ready?.adapterSourceContents).toContain('*out_result = false;');
    expect(ready?.adapterSourceContents).toContain('*out_result = flight::geometry::ready();');
    expect(setEnabled?.headerContents).toContain(
      'FLIGHT_CPP_API flight_cpp_status flight_cpp_set_enabled(bool enabled);',
    );
    expect(setEnabled?.adapterSourceContents).toContain('flight::geometry::set_enabled(enabled);');
    expect(setEnabled?.adapterSourceContents).not.toContain('out_result');
  });

  it('initializes out results before validation and translates every C++ exception to planned status', () => {
    const plan = createPlan('export function measure(value: number): number { return value; }');
    const source = emitCompilerCppCAbiPlan(plan).functions[0]!.adapterSourceContents;

    expect(source.indexOf('*out_result = 0.0;')).toBeLessThan(source.indexOf('if (out_result == nullptr)'));
    expect(source.indexOf('if (out_result == nullptr)')).toBeLessThan(source.indexOf('try {'));
    expect(source).toContain('} catch (...) {\n    return FLIGHT_CPP_STATUS_EXCEPTION;\n  }');
    expect(source).not.toMatch(/\bthrow\b/u);
  });

  it('keeps headers C-only and deterministic while leaving input plans unchanged', () => {
    const source = `
      export function zeta(value: number): void { void value; }
      export function alpha(value: boolean): boolean { return value; }
    `;
    const plan = createPlan(source);
    const reversed: CompilerCppCAbiPlan = { ...plan, functions: [...plan.functions].reverse() };
    const before = structuredClone(reversed);

    const forwardEmission = emitCompilerCppCAbiPlan(plan);
    const reverseEmission = emitCompilerCppCAbiPlan(reversed);

    expect(reverseEmission).toEqual(forwardEmission);
    expect(reversed).toEqual(before);
    expect(forwardEmission.functions.map((item) => item.symbol)).toEqual(['flight_cpp_alpha', 'flight_cpp_zeta']);
    for (const { headerContents } of forwardEmission.functions) {
      expect(headerContents).not.toMatch(/::|\bnamespace\b|\btemplate\b|\bstd\b|\btry\b|\bcatch\b|\bthrow\b|&/u);
      expect(headerContents).toContain('typedef enum flight_cpp_status');
      expect(headerContents).toContain('#include <stdbool.h>');
    }
  });

  it('emits explicit presence fields and preserves absent, zero, and false record inputs', () => {
    const plan = createPlan(`
      interface Options { sampleCount: number; enabled: boolean; }
      export function apply(options: Partial<Options>): void { void options; }
    `);
    const before = structuredClone(plan);

    const emission = emitCompilerCppCAbiPlan(plan);
    const record = emission.records[0]!;
    const apply = emission.functions[0]!;

    expect(record.headerContents).toContain(`struct flight_cpp_apply_options_record {
  bool has_sample_count;
  double sample_count;
  bool has_enabled;
  bool enabled;
};`);
    expect(apply.headerContents).toContain(record.headerContents.trim().split('\n').slice(2).join('\n'));
    expect(apply.headerContents).toContain('flight_cpp_apply(const struct flight_cpp_apply_options_record* options);');
    expect(apply.adapterSourceContents).toContain('if (options == nullptr) {');
    expect(apply.adapterSourceContents).toContain(
      'using flight_cpp_adapter_argument_0 = std::remove_cvref_t<decltype(flight_cpp_adapter_argument_type<0>(&flight::geometry::apply))>;',
    );
    expect(apply.adapterSourceContents).toContain(
      'flight::make_ref<flight_cpp_adapter_argument_0_element>(flight_cpp_adapter_argument_0_element{',
    );
    expect(apply.adapterSourceContents).toContain(
      '.sample_count = options->has_sample_count ? std::optional<double>{options->sample_count} : std::nullopt',
    );
    expect(apply.adapterSourceContents).toContain(
      '.enabled = options->has_enabled ? std::optional<bool>{options->enabled} : std::nullopt',
    );
    expect(apply.adapterSourceContents).not.toMatch(/options->sample_count\s*\?/u);
    expect(apply.adapterSourceContents).not.toMatch(/options->enabled\s*\?/u);
    expect(plan).toEqual(before);
  });

  it('clears optional record outputs before validation and preserves present zero and false', () => {
    const plan = createPlan(`
      export function snapshot(): { sampleCount?: number; enabled?: boolean } { return {}; }
    `);

    const source = emitCompilerCppCAbiPlan(plan).functions[0]!.adapterSourceContents;

    expect(source).toContain('out_result->has_sample_count = false;\n    out_result->sample_count = 0.0;');
    expect(source).toContain('out_result->has_enabled = false;\n    out_result->enabled = false;');
    expect(source.indexOf('out_result->has_sample_count = false;')).toBeLessThan(
      source.indexOf('if (out_result == nullptr)'),
    );
    expect(source).toContain('out_result->has_sample_count = flight_cpp_adapter_result->sample_count.has_value();');
    expect(source).toContain('out_result->sample_count = flight_cpp_adapter_result->sample_count.value_or(0.0);');
    expect(source).toContain('out_result->has_enabled = flight_cpp_adapter_result->enabled.has_value();');
    expect(source).toContain('out_result->enabled = flight_cpp_adapter_result->enabled.value_or(false);');
    expect(source).toContain('} catch (...) {\n    return FLIGHT_CPP_STATUS_EXCEPTION;\n  }');
  });

  it('emits one opaque wrapper lifecycle with owned creation and retained identity', () => {
    const plan = createPlan(`
      export interface Point { x: number; }
      export function createPoint(): Point { return { x: 1 }; }
    `);

    const emission = emitCompilerCppCAbiPlan(plan);
    const handle = emission.handles[0]!;
    const createPoint = emission.functions[0]!;

    expect(handle.headerContents).toContain('struct flight_cpp_point;');
    expect(handle.headerContents).toContain(
      'FLIGHT_CPP_API struct flight_cpp_point* flight_cpp_point_retain(struct flight_cpp_point* handle);',
    );
    expect(handle.headerContents).toContain(
      'FLIGHT_CPP_API void flight_cpp_point_release(struct flight_cpp_point* handle);',
    );
    expect(handle.headerContents).not.toContain('typedef struct flight_cpp_point');
    expect(handle.headerContents).not.toContain('flight::Ref');
    expect(handle.adapterSourceContents).toContain('std::atomic<std::size_t> references{1};');
    expect(handle.adapterSourceContents).toContain('flight::Ref<flight::geometry::Point> owner;');
    expect(handle.adapterSourceContents).toContain(': owner(std::move(value)) {}');
    expect(handle.adapterSourceContents).toContain(
      'if (!owner) {\n    return nullptr;\n  }\n  return new flight_cpp_point(std::move(owner));',
    );
    expect(handle.adapterSourceContents).toContain(
      'handle->references.fetch_add(1, std::memory_order_relaxed);\n  return handle;',
    );
    expect(handle.adapterSourceContents).toContain(
      'flight_cpp_point_retain(struct flight_cpp_point* handle) {\n  if (handle == nullptr) {\n    return nullptr;',
    );
    expect(handle.adapterSourceContents).toContain(
      'if (handle == nullptr) {\n    return;\n  }\n  if (handle->references.fetch_sub(1, std::memory_order_acq_rel) == 1) {\n    delete handle;',
    );
    expect(handle.adapterSourceContents).not.toMatch(/owner\.(?:reset|release)|delete\s+handle->owner/u);
    expect(createPoint.headerContents).toContain(
      'FLIGHT_CPP_API flight_cpp_status flight_cpp_create_point(struct flight_cpp_point** out_result);',
    );
    expect(createPoint.adapterSourceContents).toContain('*out_result = nullptr;');
    expect(createPoint.adapterSourceContents).toContain(
      '*out_result = flight_cpp_point_create_owned(flight::geometry::create_point());',
    );
  });

  it('borrows required handles without consuming them and clears owned outputs before every failure', () => {
    const plan = createPlan(`
      export interface Point { x: number; }
      export function clonePoint(source: Point): Point { return { x: source.x }; }
    `);

    const source = emitCompilerCppCAbiPlan(plan).functions[0]!.adapterSourceContents;

    expect(source).toContain(
      'const flight::Ref<flight::geometry::Point>& flight_cpp_point_borrow_owner(const struct flight_cpp_point* handle) noexcept;',
    );
    expect(source).toContain(
      'flight_cpp_clone_point(struct flight_cpp_point* source, struct flight_cpp_point** out_result)',
    );
    expect(source.indexOf('*out_result = nullptr;')).toBeLessThan(source.indexOf('if (out_result == nullptr)'));
    expect(source.indexOf('if (out_result == nullptr)')).toBeLessThan(source.indexOf('if (source == nullptr)'));
    expect(source.indexOf('if (source == nullptr)')).toBeLessThan(source.indexOf('try {'));
    expect(source).toContain(
      'flight_cpp_point_create_owned(flight::geometry::clone_point(flight_cpp_point_borrow_owner(source)))',
    );
    expect(source).toContain('} catch (...) {\n    return FLIGHT_CPP_STATUS_EXCEPTION;\n  }');
    expect(source).not.toContain('flight_cpp_point_retain(source)');
    expect(source).not.toContain('std::move(source)');
    expect(source).not.toMatch(/\bthrow\b/u);
  });

  it('maps a single nullable handle sentinel to a null C pointer in both directions', () => {
    const plan = createPlan(`
      export interface Point { x: number; }
      export function findPoint(source: Point | null): Point | undefined { return source ?? undefined; }
    `);

    const findPoint = emitCompilerCppCAbiPlan(plan).functions[0]!;

    expect(findPoint.headerContents).toContain(
      'flight_cpp_find_point(struct flight_cpp_point* source, struct flight_cpp_point** out_result);',
    );
    expect(findPoint.adapterSourceContents).not.toContain('if (source == nullptr)');
    expect(findPoint.adapterSourceContents).toContain(
      'source == nullptr ? flight_cpp_adapter_argument_0{std::nullopt} : flight_cpp_adapter_argument_0{flight_cpp_point_borrow_owner(source)}',
    );
    expect(findPoint.adapterSourceContents).toContain(
      'if (flight_cpp_adapter_result.has_value()) {\n      *out_result = flight_cpp_point_create_owned(flight_cpp_adapter_result.value());\n    }',
    );
  });

  it('refuses two otherwise valid lifecycle records for one C++ owner', () => {
    const plan = createPlan(`
      export interface Point { x: number; }
      export function createPoint(): Point { return { x: 1 }; }
    `);
    const handle = plan.handles[0]!;
    const ambiguous = {
      ...plan,
      handles: [
        handle,
        {
          ...handle,
          borrowSymbol: 'flight_cpp_point_alias_borrow_owner',
          carrier: 'flight_cpp_point_alias',
          createOwnedSymbol: 'flight_cpp_point_alias_create_owned',
          releaseSymbol: 'flight_cpp_point_alias_release',
          retainSymbol: 'flight_cpp_point_alias_retain',
        },
      ],
    } satisfies CompilerCppCAbiPlan;
    let failure: unknown;

    try {
      emitCompilerCppCAbiPlan(ambiguous);
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({
        code: 'ambiguous-lifecycle',
        kind: 'cpp-c-abi-emission',
        symbol: 'flight_cpp_point_alias_retain',
      }),
    );
    expect(isCompilerCppCAbiEmissionFailure(failure)).toBe(true);
  });

  it('bridges readonly views through one exact owner and keeps Pick aliases opaque in C', () => {
    const plan = createPlan(`
      export interface Vector { x: number; y: number; }
      type VectorPosition<Key extends keyof Vector> = Pick<Vector, Key>;
      type VectorPositionAlias = VectorPosition<'x' | 'y'>;
      export function inspect(vector: Readonly<Vector>): Readonly<Vector> { return vector; }
      export function project(vector: VectorPositionAlias): VectorPositionAlias { return vector; }
    `);
    const before = structuredClone(plan);
    const emission = emitCompilerCppCAbiPlan(plan);
    const inspect = emission.functions.find((item) => item.symbol === 'flight_cpp_inspect')!;
    const project = emission.functions.find((item) => item.symbol === 'flight_cpp_project')!;

    expect(inspect.headerContents).toContain(
      'flight_cpp_inspect(const struct flight_cpp_vector* vector, struct flight_cpp_vector** out_result);',
    );
    expect(inspect.headerContents).not.toMatch(/StructuralRef|RowReadonly|flight::|\bstd\b|\btemplate\b/u);
    expect(inspect.headerContents).not.toContain('struct flight_cpp_vector {');
    expect(inspect.adapterSourceContents).toContain(
      'using flight_cpp_adapter_argument_0 = std::remove_cvref_t<decltype(flight_cpp_adapter_argument_type<0>(&flight::geometry::inspect))>;',
    );
    expect(inspect.adapterSourceContents).toContain(
      'flight_cpp_adapter_argument_0{flight_cpp_vector_borrow_owner(vector)}',
    );
    expect(inspect.adapterSourceContents).toContain(
      'flight_cpp_vector_create_owned(flight::structural_ref_cast<flight::Ref<flight::geometry::Vector>>(flight_cpp_adapter_result))',
    );
    expect(inspect.adapterSourceContents.match(/flight::structural_ref_cast/gu)).toHaveLength(1);
    expect(inspect.adapterSourceContents).not.toContain('flight_cpp_vector_retain(vector)');
    expect(inspect.adapterSourceContents).not.toContain('make_structural_ref');

    expect(project.headerContents).toContain(
      'flight_cpp_project(struct flight_cpp_vector* vector, struct flight_cpp_vector** out_result);',
    );
    expect(project.headerContents).not.toMatch(/VectorPosition|StructuralRef|flight::|\bstd\b|\btemplate\b/u);
    expect(project.adapterSourceContents).toContain(
      'flight_cpp_vector_create_owned(flight::geometry::project(flight_cpp_vector_borrow_owner(vector)))',
    );
    expect(project.adapterSourceContents).not.toContain('structural_ref_cast');
    expect(plan).toEqual(before);
  });
});

describe('emitCompilerCppCAbiPackage', () => {
  it('aggregates accepted carriers into one configured C11 header and one C++ adapter source', () => {
    const plan = createPlan(`
      export interface Vector { x: number; y: number; }
      interface Options { count: number; enabled: boolean; }
      export function configure(options: Partial<Options>): void { void options; }
      export function inspect(vector: Readonly<Vector>): Readonly<Vector> { return vector; }
      export function scale(value: number): number { return value * 2; }
    `);

    const files = emitCompilerCppCAbiPackage(
      plan,
      {
        adapterSourcePath: 'generated/geometry_c.cpp',
        headerPath: 'include/geometry_c.h',
        packageName: '@flight/geometry',
      },
      '0123456789abcdef0123456789abcdef01234567',
    );
    const adapter = files.find((file) => file.path.endsWith('.cpp'))!;
    const header = files.find((file) => file.path.endsWith('.h'))!;

    expect(files.map((file) => file.path)).toEqual(['generated/geometry_c.cpp', 'include/geometry_c.h']);
    expect(header.contents).toContain(
      '// Generated by @flighthq/tool-compiler from package @flight/geometry at 0123456789abcdef0123456789abcdef01234567. Do not edit.',
    );
    expect(header.contents).toContain('struct flight_cpp_vector;');
    expect(header.contents).toContain('struct flight_cpp_configure_options_record {');
    expect(header.contents).toContain('flight_cpp_status flight_cpp_scale(double value, double* out_result);');
    expect(header.contents).not.toMatch(/StructuralRef|flight::|\bstd\b|\btemplate\b/u);
    expect(adapter.dependencies).toEqual(['flight/geometry/geometry.hpp', 'include/geometry_c.h']);
    expect(adapter.contents).toContain('#include <include/geometry_c.h>');
    expect(adapter.contents).toContain('flight_cpp_configure_adapter_argument_type');
    expect(adapter.contents).toContain('flight_cpp_inspect_adapter_argument_type');
    expect(adapter.contents).not.toContain('auto flight_cpp_adapter_argument_type');
    expect(adapter.contents).toContain('flight::structural_ref_cast<flight::Ref<flight::geometry::Vector>>');
  });

  it('fails loudly when accepted candidates collide in the global C namespace', () => {
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
    const plan = createIrModulesCAbiPlanCpp([geometry, image], {
      ...geometryTarget,
      packageName: '@flight/geometry',
    });

    expect(() =>
      emitCompilerCppCAbiPackage(plan, {
        adapterSourcePath: 'generated/geometry_c.cpp',
        headerPath: 'include/geometry_c.h',
        packageName: '@flight/geometry',
      }),
    ).toThrow(expect.objectContaining({ code: 'global-symbol-collision', kind: 'cpp-c-abi-emission' }));
  });
});

describe('createCppCompilerBackend C ABI package output', () => {
  it('does no package-finalization work when disabled and returns two package-owned files when elected', () => {
    const module = lower('geometry.ts', 'export function scale(value: number): number { return value * 2; }');
    const backend = createCppCompilerBackend();
    const disabled = backend.createEmissionSession!({ modules: [module], options: geometryTarget });
    const enabled = backend.createEmissionSession!({
      modules: [module],
      options: {
        ...geometryTarget,
        cAbi: {
          adapterSourcePath: 'generated/geometry_c.cpp',
          headerPath: 'include/geometry_c.h',
          packageName: '@flight/geometry',
        },
      },
    });

    expect(disabled.finalizePackageGraph).toBeUndefined();
    expect(disabled.emitModule(module)).toEqual(
      backend.emitModule(module, { modules: [module], options: geometryTarget }),
    );
    expect(enabled.finalizePackageGraph?.()).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ path: 'generated/geometry_c.cpp' }),
        owner: { kind: 'package', packageName: '@flight/geometry' },
        provenance: [{ name: module.name, packageName: module.packageName, source: module.source }],
      }),
      expect.objectContaining({
        file: expect.objectContaining({ path: 'include/geometry_c.h' }),
        owner: { kind: 'package', packageName: '@flight/geometry' },
        provenance: [{ name: module.name, packageName: module.packageName, source: module.source }],
      }),
    ]);
  });
});

describe('isCompilerCppCAbiEmissionFailure', () => {
  it('accepts emitted refusals and rejects malformed lookalikes', () => {
    const plan = createPlan('export function scalar(value: number): number { return value; }');
    const invalid = {
      ...plan,
      functions: [{ ...plan.functions[0]!, parameters: [{ ...plan.functions[0]!.parameters[0]!, carrier: 'int' }] }],
    } as unknown as CompilerCppCAbiPlan;
    let failure: unknown;
    try {
      emitCompilerCppCAbiPlan(invalid);
    } catch (error) {
      failure = error;
    }

    expect(isCompilerCppCAbiEmissionFailure(failure)).toBe(true);
    expect(isCompilerCppCAbiEmissionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerCppCAbiEmissionFailure(
        Object.assign(new Error('lookalike'), {
          bindingId: '',
          code: 'unknown',
          kind: 'cpp-c-abi-emission',
          packageName: '',
          source: '',
          symbol: '',
        } satisfies Omit<CompilerCppCAbiEmissionFailure, keyof Error | 'code'> & { code: string }),
      ),
    ).toBe(false);
  });
});

function createPlan(source: string): CompilerCppCAbiPlan {
  const plan = createIrModulesCAbiPlanCpp([lower('geometry.ts', source)], geometryTarget);
  expect(plan.diagnostics).toEqual([]);
  return plan;
}

function lower(file: string, source: string, packageName = '@flight/geometry'): IrModule {
  const sourceFile = ts.createSourceFile(`/flight/packages/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '/flight' }).module;
}

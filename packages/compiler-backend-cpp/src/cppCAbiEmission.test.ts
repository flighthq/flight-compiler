import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerCppCAbiEmissionFailure, CompilerCppCAbiPlan, IrModule } from '../../compiler-types/src/index.js';
import { emitCompilerCppCAbiPlan, isCompilerCppCAbiEmissionFailure } from './cppCAbiEmission.js';
import { createIrModulesCAbiPlanCpp } from './cppCAbiPlan.js';

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
          adapterSourceContents: `#include <flight/geometry.h>

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
          headerPath: 'flight/geometry.h',
          packageName: '@flight/geometry',
          source: plan.functions[0]?.source,
          symbol: 'flight_cpp_add',
        },
      ],
      handles: [],
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

  it('refuses non-scalar carriers without emitting C++ type spelling', () => {
    const module = lower(
      'handle.ts',
      `
        export interface Point { x: number; }
        export function inspect(point: Readonly<Point>): Point { return { x: point.x }; }
      `,
    );
    const plan = createIrModulesCAbiPlanCpp([module], geometryTarget);
    const before = structuredClone(plan);
    let failure: unknown;

    try {
      emitCompilerCppCAbiPlan(plan);
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      expect.objectContaining({
        code: 'unsupported-carrier',
        kind: 'cpp-c-abi-emission',
        symbol: 'flight_cpp_inspect',
      }),
    );
    expect((failure as Error).message).not.toMatch(/::|\bstd\b|[<>&]/u);
    expect(plan).toEqual(before);
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

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

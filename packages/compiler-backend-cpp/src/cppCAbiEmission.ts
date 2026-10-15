import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerCppCAbiEmission,
  CompilerCppCAbiEmissionFailure,
  CompilerCppCAbiEmissionFailureCode,
  CompilerCppCAbiFunctionEmission,
  CompilerCppCAbiFunctionPlan,
  CompilerCppCAbiParameterPlan,
  CompilerCppCAbiPlan,
} from '../../compiler-types/src/index.js';

interface ScalarFunctionPlan {
  readonly function: Readonly<CompilerCppCAbiFunctionPlan>;
  readonly parameters: readonly Readonly<CompilerCppCAbiParameterPlan>[];
  readonly result:
    | Readonly<{ kind: 'void' }>
    | Readonly<{ carrier: 'bool*' | 'double*'; initialization: 'false' | '0.0'; kind: 'out' }>;
}

const cAbiEmissionFailureCodes = {
  'invalid-plan': true,
  'unsupported-carrier': true,
} as const satisfies Readonly<Record<CompilerCppCAbiEmissionFailureCode, true>>;

export function emitCompilerCppCAbiPlan(sourcePlan: Readonly<CompilerCppCAbiPlan>): CompilerCppCAbiEmission {
  const plan = structuredClone(sourcePlan);
  if (plan.schema !== 'flight-compiler-cpp-c-abi-plan/1') {
    throw createCompilerCppCAbiEmissionFailure(undefined, 'invalid-plan', 'unsupported C ABI plan schema');
  }
  const functions = [...plan.functions].sort(compareFunctionPlans);
  const symbols = new Set<string>();
  const emissions = functions.map((functionPlan): CompilerCppCAbiFunctionEmission => {
    if (symbols.has(functionPlan.symbol)) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'invalid-plan',
        `C ABI plan repeats global symbol ${functionPlan.symbol}`,
      );
    }
    symbols.add(functionPlan.symbol);
    const scalarPlan = validateScalarFunctionPlan(functionPlan);
    return {
      adapterSourceContents: emitAdapterSourceContents(scalarPlan),
      bindingId: functionPlan.bindingId,
      headerContents: emitHeaderContents(scalarPlan),
      headerPath: functionPlan.header,
      packageName: functionPlan.packageName,
      source: functionPlan.source,
      symbol: functionPlan.symbol,
    };
  });
  return { functions: emissions, schema: 'flight-compiler-cpp-c-abi-emission/1' };
}

export function isCompilerCppCAbiEmissionFailure(value: unknown): value is CompilerCppCAbiEmissionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'cpp-c-abi-emission' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(cAbiEmissionFailureCodes, value.code) &&
    'bindingId' in value &&
    typeof value.bindingId === 'string' &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
    'source' in value &&
    typeof value.source === 'string' &&
    'symbol' in value &&
    typeof value.symbol === 'string'
  );
}

function validateScalarFunctionPlan(functionPlan: Readonly<CompilerCppCAbiFunctionPlan>): ScalarFunctionPlan {
  assertFunctionIdentity(functionPlan);
  assertErrorPlan(functionPlan);
  const parameters = [...functionPlan.parameters].sort((left, right) => left.position - right.position);
  const parameterNames = new Set<string>();
  for (const [position, parameter] of parameters.entries()) {
    if (parameter.position !== position || parameterNames.has(parameter.name) || !isCIdentifier(parameter.name)) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'invalid-plan',
        `C ABI parameters for ${functionPlan.symbol} are not uniquely and contiguously ordered`,
      );
    }
    parameterNames.add(parameter.name);
    if (
      parameter.adapter !== 'copy-scalar-from-c' ||
      !isScalarCarrier(parameter.carrier) ||
      parameter.ownership !== 'value' ||
      parameter.presence !== 'required'
    ) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'unsupported-carrier',
        `C ABI parameter ${parameter.name} of ${functionPlan.symbol} is not a required scalar value`,
      );
    }
  }

  if (functionPlan.result.kind === 'void') {
    if (
      functionPlan.result.adapter !== 'none' ||
      functionPlan.result.ownership !== 'none' ||
      functionPlan.result.presence !== 'not-applicable'
    ) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'invalid-plan',
        `void C ABI result for ${functionPlan.symbol} has inconsistent metadata`,
      );
    }
    return { function: functionPlan, parameters, result: { kind: 'void' } };
  }
  if (
    functionPlan.result.adapter !== 'copy-scalar-to-out' ||
    (functionPlan.result.carrier !== 'bool*' && functionPlan.result.carrier !== 'double*') ||
    functionPlan.result.initialization !== 'zero' ||
    functionPlan.result.name !== 'out_result' ||
    functionPlan.result.ownership !== 'value' ||
    functionPlan.result.presence !== 'required'
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      functionPlan,
      'unsupported-carrier',
      `C ABI result of ${functionPlan.symbol} is not a required scalar out value`,
    );
  }
  return {
    function: functionPlan,
    parameters,
    result: {
      carrier: functionPlan.result.carrier,
      initialization: functionPlan.result.carrier === 'bool*' ? 'false' : '0.0',
      kind: 'out',
    },
  };
}

function assertFunctionIdentity(functionPlan: Readonly<CompilerCppCAbiFunctionPlan>): void {
  if (
    functionPlan.bindingId.length === 0 ||
    functionPlan.packageName.length === 0 ||
    functionPlan.source.length === 0 ||
    functionPlan.visibility !== 'FLIGHT_CPP_API' ||
    !/^flight_cpp_[a-z_][a-z0-9_]*$/u.test(functionPlan.symbol) ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/u.test(functionPlan.cppTarget) ||
    !isCHeaderPath(functionPlan.header)
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      functionPlan,
      'invalid-plan',
      `C ABI function ${functionPlan.symbol || '<unnamed>'} has invalid target identity metadata`,
    );
  }
}

function assertErrorPlan(functionPlan: Readonly<CompilerCppCAbiFunctionPlan>): void {
  const error = functionPlan.error;
  if (
    !error.catchesCppExceptions ||
    error.exceptionConstant !== 'FLIGHT_CPP_STATUS_EXCEPTION' ||
    !error.initializesOutResultBeforeValidation ||
    error.invalidArgumentConstant !== 'FLIGHT_CPP_STATUS_INVALID_ARGUMENT' ||
    error.lastError !== 'none' ||
    error.statusCarrier !== 'flight_cpp_status' ||
    error.strategy !== 'status-return' ||
    error.successConstant !== 'FLIGHT_CPP_STATUS_OK'
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      functionPlan,
      'invalid-plan',
      `C ABI function ${functionPlan.symbol} does not carry the complete ABI v1 error strategy`,
    );
  }
}

function emitHeaderContents(plan: ScalarFunctionPlan): string {
  const { function: functionPlan } = plan;
  const guard = `FLIGHT_CPP_C_ABI_${functionPlan.symbol.toUpperCase()}_H`;
  const lines = [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
    '#include <stdbool.h>',
    '',
    '#ifndef FLIGHT_CPP_API',
    '#if defined(_WIN32)',
    '#if defined(FLIGHT_CPP_BUILD)',
    '#define FLIGHT_CPP_API __declspec(dllexport)',
    '#else',
    '#define FLIGHT_CPP_API __declspec(dllimport)',
    '#endif',
    '#elif defined(__GNUC__)',
    '#define FLIGHT_CPP_API __attribute__((visibility("default")))',
    '#else',
    '#define FLIGHT_CPP_API',
    '#endif',
    '#endif',
    '',
    '#ifndef FLIGHT_CPP_ABI_V1_STATUS_DEFINED',
    '#define FLIGHT_CPP_ABI_V1_STATUS_DEFINED',
    'typedef enum flight_cpp_status {',
    `  ${functionPlan.error.successConstant} = 0,`,
    `  ${functionPlan.error.invalidArgumentConstant} = 1,`,
    `  ${functionPlan.error.exceptionConstant} = 2`,
    '} flight_cpp_status;',
    '#endif',
    '',
    '#if defined(__cplusplus)',
    'extern "C" {',
    '#endif',
    '',
    `${emitFunctionSignature(plan)};`,
    '',
    '#if defined(__cplusplus)',
    '}',
    '#endif',
    '',
    `#endif /* ${guard} */`,
    '',
  ];
  return lines.join('\n');
}

function emitAdapterSourceContents(plan: ScalarFunctionPlan): string {
  const { function: functionPlan } = plan;
  const lines = [`#include <${functionPlan.header}>`, '', `extern "C" ${emitFunctionSignature(plan)} {`];
  if (plan.result.kind === 'out') {
    lines.push(
      '  if (out_result != nullptr) {',
      `    *out_result = ${plan.result.initialization};`,
      '  }',
      '  if (out_result == nullptr) {',
      `    return ${functionPlan.error.invalidArgumentConstant};`,
      '  }',
    );
  }
  const arguments_ = plan.parameters.map((parameter) => parameter.name).join(', ');
  lines.push('  try {');
  if (plan.result.kind === 'out') {
    lines.push(`    *out_result = ${functionPlan.cppTarget}(${arguments_});`);
  } else {
    lines.push(`    ${functionPlan.cppTarget}(${arguments_});`);
  }
  lines.push(
    `    return ${functionPlan.error.successConstant};`,
    '  } catch (...) {',
    `    return ${functionPlan.error.exceptionConstant};`,
    '  }',
    '}',
    '',
  );
  return lines.join('\n');
}

function emitFunctionSignature(plan: ScalarFunctionPlan): string {
  const parameters = plan.parameters.map((parameter) => `${parameter.carrier} ${parameter.name}`);
  if (plan.result.kind === 'out') parameters.push(`${plan.result.carrier} out_result`);
  return `${plan.function.visibility} ${plan.function.error.statusCarrier} ${plan.function.symbol}(${parameters.length > 0 ? parameters.join(', ') : 'void'})`;
}

function createCompilerCppCAbiEmissionFailure(
  functionPlan: Readonly<CompilerCppCAbiFunctionPlan> | undefined,
  code: CompilerCppCAbiEmissionFailureCode,
  message: string,
): CompilerCppCAbiEmissionFailure {
  const failure = Object.assign(new Error(message), {
    bindingId: functionPlan?.bindingId ?? '',
    code,
    kind: 'cpp-c-abi-emission' as const,
    packageName: functionPlan?.packageName ?? '',
    source: functionPlan?.source ?? '',
    symbol: functionPlan?.symbol ?? '',
  });
  failure.name = 'CompilerCppCAbiEmissionError';
  return failure;
}

function compareFunctionPlans(
  left: Readonly<CompilerCppCAbiFunctionPlan>,
  right: Readonly<CompilerCppCAbiFunctionPlan>,
): number {
  return compareTextCodeUnits(
    `${left.symbol}\0${left.packageName}\0${left.source}\0${left.bindingId}`,
    `${right.symbol}\0${right.packageName}\0${right.source}\0${right.bindingId}`,
  );
}

function isCHeaderPath(value: string): boolean {
  return (
    value.length > 2 &&
    value.endsWith('.h') &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[<>"\r\n]/u.test(value) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function isCIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function isScalarCarrier(value: string): value is 'bool' | 'double' {
  return value === 'bool' || value === 'double';
}

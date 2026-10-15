import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { createCompilerGeneratedPackageFileHeader } from '../../compiler-emission/src/index.js';
import type {
  CompilerCppCAbiEmission,
  CompilerCppCAbiEmissionFailure,
  CompilerCppCAbiEmissionFailureCode,
  CompilerCppCAbiFunctionEmission,
  CompilerCppCAbiFunctionPlan,
  CompilerCppCAbiHandleEmission,
  CompilerCppCAbiHandlePlan,
  CompilerCppCAbiParameterPlan,
  CompilerCppCAbiPlan,
  CompilerCppCAbiPresence,
  CompilerCppCAbiRecordEmission,
  CompilerCppCAbiRecordPlan,
  CppCompilerCAbiOutput,
  EmittedFile,
} from '../../compiler-types/src/index.js';

interface EmissionFailureIdentity {
  readonly bindingId: string;
  readonly packageName: string;
  readonly source: string;
  readonly symbol: string;
}

interface HandleParameterPlan {
  readonly handle: Readonly<CompilerCppCAbiHandlePlan>;
  readonly kind: 'handle';
  readonly parameter: Readonly<CompilerCppCAbiParameterPlan>;
}

interface ScalarParameterPlan {
  readonly kind: 'scalar';
  readonly parameter: Readonly<CompilerCppCAbiParameterPlan>;
}

interface RecordParameterPlan {
  readonly kind: 'record';
  readonly parameter: Readonly<CompilerCppCAbiParameterPlan>;
  readonly record: Readonly<CompilerCppCAbiRecordPlan>;
}

type EmissionParameterPlan = HandleParameterPlan | RecordParameterPlan | ScalarParameterPlan;

interface FunctionEmissionPlan {
  readonly function: Readonly<CompilerCppCAbiFunctionPlan>;
  readonly parameters: readonly EmissionParameterPlan[];
  readonly result:
    | Readonly<{ kind: 'void' }>
    | Readonly<{ carrier: 'bool*' | 'double*'; initialization: 'false' | '0.0'; kind: 'scalar' }>
    | Readonly<{
        adapter: 'create-owned-handle-to-out' | 'recover-readonly-owner-handle-to-out';
        handle: Readonly<CompilerCppCAbiHandlePlan>;
        kind: 'handle';
        presence: Exclude<CompilerCppCAbiPresence, 'not-applicable'>;
      }>
    | Readonly<{ kind: 'record'; record: Readonly<CompilerCppCAbiRecordPlan> }>;
}

const cAbiEmissionFailureCodes = {
  'ambiguous-lifecycle': true,
  'global-symbol-collision': true,
  'invalid-plan': true,
  'unsupported-carrier': true,
} as const satisfies Readonly<Record<CompilerCppCAbiEmissionFailureCode, true>>;

export function emitCompilerCppCAbiPackage(
  sourcePlan: Readonly<CompilerCppCAbiPlan>,
  output: Readonly<CppCompilerCAbiOutput>,
  upstreamCommit?: string,
): readonly EmittedFile[] {
  const collision = sourcePlan.diagnostics.find((diagnostic) => diagnostic.code === 'global-symbol-collision');
  if (collision) {
    throw createCompilerCppCAbiEmissionFailure(
      {
        bindingId: collision.bindingId,
        packageName: collision.packageName,
        source: collision.source,
        symbol: collision.sourceName,
      },
      'global-symbol-collision',
      collision.message,
    );
  }
  if (
    output.packageName.length === 0 ||
    !output.headerPath.endsWith('.h') ||
    !output.adapterSourcePath.endsWith('.cpp') ||
    sourcePlan.functions.some((functionPlan) => functionPlan.packageName !== output.packageName)
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      undefined,
      'invalid-plan',
      `C ABI package output for ${output.packageName || '<unnamed>'} has inconsistent package or file metadata`,
    );
  }
  const emission = emitCompilerCppCAbiPlan(sourcePlan);
  const provenance = createCompilerGeneratedPackageFileHeader(output.packageName, '//', upstreamCommit);
  const headerFragments = [
    ...emission.records.map((record) => record.headerContents),
    ...emission.handles.map((handle) => handle.headerContents),
    ...emission.functions.map((function_) => function_.headerContents),
  ];
  const adapterFragments = [
    `#include <${output.headerPath}>`,
    ...emission.handles.map((handle) => handle.adapterSourceContents),
    ...emission.functions.map((function_) =>
      function_.adapterSourceContents.replaceAll('flight_cpp_adapter_', `${function_.symbol}_adapter_`),
    ),
  ];
  const dependencies = [
    ...new Set([output.headerPath, ...[...sourcePlan.handles, ...sourcePlan.functions].map((item) => item.header)]),
  ].sort(compareTextCodeUnits);
  return [
    {
      contents: combineCompilerCppCAbiPackageFragments(provenance, headerFragments),
      path: output.headerPath,
    },
    {
      contents: combineCompilerCppCAbiPackageFragments(provenance, adapterFragments),
      ...(dependencies.length === 0 ? {} : { dependencies }),
      path: output.adapterSourcePath,
    },
  ].sort((left, right) => compareTextCodeUnits(left.path, right.path));
}

export function emitCompilerCppCAbiPlan(sourcePlan: Readonly<CompilerCppCAbiPlan>): CompilerCppCAbiEmission {
  const plan = structuredClone(sourcePlan);
  if (plan.schema !== 'flight-compiler-cpp-c-abi-plan/1') {
    throw createCompilerCppCAbiEmissionFailure(undefined, 'invalid-plan', 'unsupported C ABI plan schema');
  }

  const records = validateRecordPlans(plan.records);
  const recordsByCarrier = new Map(records.map((record) => [record.carrier, record]));
  const recordEmissions = records.map(
    (record): CompilerCppCAbiRecordEmission => ({
      bindingId: record.bindingId,
      carrier: record.carrier,
      headerContents: emitRecordHeaderContents(record),
      headerPath: record.header,
      packageName: record.packageName,
      source: record.source,
      sourceName: record.sourceName,
    }),
  );
  const handles = validateHandlePlans(plan.handles);
  const handlesByCarrier = new Map(handles.map((handle) => [handle.carrier, handle]));
  for (const handle of handles) {
    if (recordsByCarrier.has(handle.carrier)) {
      throw createCompilerCppCAbiEmissionFailure(
        handleIdentity(handle),
        'invalid-plan',
        `C ABI tag ${handle.carrier} is both a handle and a record`,
      );
    }
  }
  const publicSymbols = new Set<string>();
  const handleEmissions = handles.map((handle): CompilerCppCAbiHandleEmission => {
    reserveSymbol(publicSymbols, handleIdentity(handle), handle.borrowSymbol);
    reserveSymbol(publicSymbols, handleIdentity(handle), handle.createOwnedSymbol);
    reserveSymbol(publicSymbols, handleIdentity(handle), handle.releaseSymbol);
    reserveSymbol(publicSymbols, handleIdentity(handle), handle.retainSymbol);
    return {
      adapterSourceContents: emitHandleAdapterSourceContents(handle),
      bindingId: handle.bindingId,
      carrier: handle.carrier,
      headerContents: emitHandleHeaderContents(handle),
      headerPath: handle.header,
      packageName: handle.packageName,
      releaseSymbol: handle.releaseSymbol,
      retainSymbol: handle.retainSymbol,
      source: handle.source,
    };
  });

  const functions = [...plan.functions].sort(compareFunctionPlans);
  const functionEmissions = functions.map((functionPlan): CompilerCppCAbiFunctionEmission => {
    reserveSymbol(publicSymbols, functionPlan, functionPlan.symbol);
    const emissionPlan = validateFunctionPlan(functionPlan, handlesByCarrier, recordsByCarrier);
    return {
      adapterSourceContents: emitFunctionAdapterSourceContents(emissionPlan),
      bindingId: functionPlan.bindingId,
      headerContents: emitFunctionHeaderContents(emissionPlan),
      headerPath: functionPlan.header,
      packageName: functionPlan.packageName,
      source: functionPlan.source,
      symbol: functionPlan.symbol,
    };
  });

  return {
    functions: functionEmissions,
    handles: handleEmissions,
    records: recordEmissions,
    schema: 'flight-compiler-cpp-c-abi-emission/1',
  };
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

function combineCompilerCppCAbiPackageFragments(provenance: string, fragments: readonly string[]): string {
  const bodies = fragments.map((fragment) => fragment.trim()).filter((fragment) => fragment.length > 0);
  return `${[provenance, ...bodies].join('\n\n')}\n`;
}

function validateHandlePlans(
  sourceHandles: readonly Readonly<CompilerCppCAbiHandlePlan>[],
): readonly Readonly<CompilerCppCAbiHandlePlan>[] {
  const handles = [...sourceHandles].sort((left, right) => compareTextCodeUnits(left.carrier, right.carrier));
  const carriers = new Set<string>();
  const targets = new Set<string>();
  for (const handle of handles) {
    if (carriers.has(handle.carrier) || targets.has(handle.cppTarget)) {
      throw createCompilerCppCAbiEmissionFailure(
        handleIdentity(handle),
        'ambiguous-lifecycle',
        `C ABI handle ${handle.carrier} does not have one lifecycle owner`,
      );
    }
    carriers.add(handle.carrier);
    targets.add(handle.cppTarget);
    assertHandlePlan(handle);
  }
  return handles;
}

function validateRecordPlans(
  sourceRecords: readonly Readonly<CompilerCppCAbiRecordPlan>[],
): readonly Readonly<CompilerCppCAbiRecordPlan>[] {
  const records = [...sourceRecords].sort((left, right) => compareTextCodeUnits(left.carrier, right.carrier));
  const carriers = new Set<string>();
  for (const record of records) {
    if (carriers.has(record.carrier)) {
      throw createCompilerCppCAbiEmissionFailure(
        recordIdentity(record),
        'invalid-plan',
        `C ABI plan repeats record carrier ${record.carrier}`,
      );
    }
    carriers.add(record.carrier);
    assertRecordPlan(record);
  }
  return records;
}

function validateFunctionPlan(
  functionPlan: Readonly<CompilerCppCAbiFunctionPlan>,
  handlesByCarrier: ReadonlyMap<string, Readonly<CompilerCppCAbiHandlePlan>>,
  recordsByCarrier: ReadonlyMap<string, Readonly<CompilerCppCAbiRecordPlan>>,
): FunctionEmissionPlan {
  assertFunctionIdentity(functionPlan);
  assertErrorPlan(functionPlan);
  const parameters = [...functionPlan.parameters].sort((left, right) => left.position - right.position);
  const parameterNames = new Set<string>();
  const emissionParameters: EmissionParameterPlan[] = [];
  for (const [position, parameter] of parameters.entries()) {
    if (parameter.position !== position || parameterNames.has(parameter.name) || !isCIdentifier(parameter.name)) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'invalid-plan',
        `C ABI parameters for ${functionPlan.symbol} are not uniquely and contiguously ordered`,
      );
    }
    parameterNames.add(parameter.name);
    if (parameter.adapter === 'copy-scalar-from-c') {
      if (!isScalarCarrier(parameter.carrier) || parameter.ownership !== 'value' || parameter.presence !== 'required') {
        throw createCompilerCppCAbiEmissionFailure(
          functionPlan,
          'unsupported-carrier',
          `C ABI parameter ${parameter.name} of ${functionPlan.symbol} is not a required scalar value`,
        );
      }
      emissionParameters.push({ kind: 'scalar', parameter });
      continue;
    }
    if (parameter.adapter === 'copy-record-from-c') {
      const record = recordsByCarrier.get(parameter.recordCarrier);
      if (
        !record ||
        parameter.carrier !== `const struct ${record.carrier}*` ||
        parameter.ownership !== 'borrowed' ||
        parameter.presence !== 'required'
      ) {
        throw createCompilerCppCAbiEmissionFailure(
          functionPlan,
          'invalid-plan',
          `C ABI parameter ${parameter.name} of ${functionPlan.symbol} does not identify one required record`,
        );
      }
      emissionParameters.push({ kind: 'record', parameter, record });
      continue;
    }
    if (parameter.adapter !== 'borrow-handle' && parameter.adapter !== 'borrow-readonly-handle') {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'unsupported-carrier',
        `C ABI parameter ${parameter.name} of ${functionPlan.symbol} is not a borrowed handle`,
      );
    }
    const handle = handlesByCarrier.get(parameter.handleCarrier);
    const expectedCarrier = `${parameter.adapter === 'borrow-readonly-handle' ? 'const ' : ''}struct ${handle?.carrier ?? ''}*`;
    if (!handle || parameter.carrier !== expectedCarrier || parameter.ownership !== 'borrowed') {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'ambiguous-lifecycle',
        `C ABI parameter ${parameter.name} of ${functionPlan.symbol} does not identify one handle lifecycle`,
      );
    }
    emissionParameters.push({ handle, kind: 'handle', parameter });
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
    return { function: functionPlan, parameters: emissionParameters, result: { kind: 'void' } };
  }
  if (functionPlan.result.adapter === 'copy-scalar-to-out') {
    if (
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
      parameters: emissionParameters,
      result: {
        carrier: functionPlan.result.carrier,
        initialization: functionPlan.result.carrier === 'bool*' ? 'false' : '0.0',
        kind: 'scalar',
      },
    };
  }
  if (functionPlan.result.adapter === 'copy-record-to-out') {
    const record = recordsByCarrier.get(functionPlan.result.recordCarrier);
    if (
      !record ||
      functionPlan.result.carrier !== `struct ${record.carrier}*` ||
      functionPlan.result.initialization !== 'record-zero' ||
      functionPlan.result.name !== 'out_result' ||
      functionPlan.result.ownership !== 'value' ||
      functionPlan.result.presence !== 'required'
    ) {
      throw createCompilerCppCAbiEmissionFailure(
        functionPlan,
        'invalid-plan',
        `C ABI result of ${functionPlan.symbol} does not identify one required record`,
      );
    }
    return { function: functionPlan, parameters: emissionParameters, result: { kind: 'record', record } };
  }
  if (
    (functionPlan.result.adapter !== 'create-owned-handle-to-out' &&
      functionPlan.result.adapter !== 'recover-readonly-owner-handle-to-out') ||
    functionPlan.result.initialization !== 'null' ||
    functionPlan.result.name !== 'out_result' ||
    functionPlan.result.ownership !== 'owned'
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      functionPlan,
      'unsupported-carrier',
      `C ABI result of ${functionPlan.symbol} is not an owned handle output`,
    );
  }
  const handle = handlesByCarrier.get(functionPlan.result.handleCarrier);
  if (!handle || functionPlan.result.carrier !== `struct ${handle.carrier}**`) {
    throw createCompilerCppCAbiEmissionFailure(
      functionPlan,
      'ambiguous-lifecycle',
      `C ABI result of ${functionPlan.symbol} does not identify one handle lifecycle`,
    );
  }
  return {
    function: functionPlan,
    parameters: emissionParameters,
    result: {
      adapter: functionPlan.result.adapter,
      handle,
      kind: 'handle',
      presence: functionPlan.result.presence,
    },
  };
}

function assertHandlePlan(handle: Readonly<CompilerCppCAbiHandlePlan>): void {
  const lifecycle = handle.lifecycle;
  if (
    handle.bindingId.length === 0 ||
    handle.packageName.length === 0 ||
    handle.source.length === 0 ||
    !/^flight_cpp_[a-z_][a-z0-9_]*$/u.test(handle.carrier) ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/u.test(handle.cppTarget) ||
    handle.cppOwnerCarrier !== `flight::Ref<${handle.cppTarget}>` ||
    handle.borrowSymbol !== `${handle.carrier}_borrow_owner` ||
    handle.createOwnedSymbol !== `${handle.carrier}_create_owned` ||
    handle.releaseSymbol !== `${handle.carrier}_release` ||
    handle.retainSymbol !== `${handle.carrier}_retain` ||
    !isCppHeaderPath(handle.header) ||
    handle.ownership !== 'opaque-reference' ||
    !lifecycle ||
    lifecycle.borrowedInput !== 'const-owner-reference' ||
    lifecycle.counter !== 'atomic-wrapper-reference-count' ||
    lifecycle.initialReferences !== 1 ||
    lifecycle.nullOwnedOutput !== 'null-handle' ||
    lifecycle.nullRelease !== 'no-op' ||
    lifecycle.nullRetain !== 'return-null' ||
    lifecycle.ownedOutput !== 'move-owner-into-new-wrapper' ||
    lifecycle.retainedResult !== 'same-handle' ||
    lifecycle.zeroReferences !== 'delete-wrapper'
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      handleIdentity(handle),
      'invalid-plan',
      `C ABI handle ${handle.carrier || '<unnamed>'} does not carry the complete ABI v1 lifecycle`,
    );
  }
}

function assertRecordPlan(record: Readonly<CompilerCppCAbiRecordPlan>): void {
  if (
    record.bindingId.length === 0 ||
    record.packageName.length === 0 ||
    record.source.length === 0 ||
    record.sourceName.length === 0 ||
    !/^flight_cpp_[a-z_][a-z0-9_]*_record$/u.test(record.carrier) ||
    record.construction !== 'flight-reference-designated-optional-aggregate' ||
    record.passing !== 'borrowed-const-pointer' ||
    !isCppHeaderPath(record.header) ||
    record.members.length === 0 ||
    !record.members.some((member) => member.presence === 'explicit-flag')
  ) {
    throw createCompilerCppCAbiEmissionFailure(
      recordIdentity(record),
      'invalid-plan',
      `C ABI record ${record.carrier || '<unnamed>'} does not carry the complete ABI v1 record strategy`,
    );
  }
  const cFields = new Set<string>();
  const cppFields = new Set<string>();
  for (const [position, member] of record.members.entries()) {
    const expectedInitialization = member.carrier === 'bool' ? 'false' : '0.0';
    const fields = member.presence === 'explicit-flag' ? [member.hasName, member.name] : [member.name];
    if (
      member.position !== position ||
      !isCIdentifier(member.name) ||
      !isCIdentifier(member.cppName) ||
      member.sourceName.length === 0 ||
      member.initialization !== expectedInitialization ||
      (member.presence === 'explicit-flag' &&
        (!isCIdentifier(member.hasName) || member.hasName !== `has_${member.name}`)) ||
      fields.some((field) => cFields.has(field)) ||
      cppFields.has(member.cppName)
    ) {
      throw createCompilerCppCAbiEmissionFailure(
        recordIdentity(record),
        'invalid-plan',
        `C ABI record ${record.carrier} has invalid or colliding member metadata`,
      );
    }
    for (const field of fields) cFields.add(field);
    cppFields.add(member.cppName);
  }
}

function assertFunctionIdentity(functionPlan: Readonly<CompilerCppCAbiFunctionPlan>): void {
  if (
    functionPlan.bindingId.length === 0 ||
    functionPlan.packageName.length === 0 ||
    functionPlan.source.length === 0 ||
    functionPlan.visibility !== 'FLIGHT_CPP_API' ||
    !/^flight_cpp_[a-z_][a-z0-9_]*$/u.test(functionPlan.symbol) ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/u.test(functionPlan.cppTarget) ||
    !isCppHeaderPath(functionPlan.header)
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

function emitRecordHeaderContents(record: Readonly<CompilerCppCAbiRecordPlan>): string {
  return ['#include <stdbool.h>', '', ...emitRecordDefinitionLines(record), ''].join('\n');
}

function emitRecordDefinitionLines(record: Readonly<CompilerCppCAbiRecordPlan>): readonly string[] {
  const guard = `FLIGHT_CPP_C_ABI_${record.carrier.toUpperCase()}_DEFINED`;
  const fields = record.members.flatMap((member): string[] => [
    ...(member.presence === 'explicit-flag' ? [`  bool ${member.hasName};`] : []),
    `  ${member.carrier} ${member.name};`,
  ]);
  return [`#ifndef ${guard}`, `#define ${guard}`, `struct ${record.carrier} {`, ...fields, '};', '#endif'];
}

function emitHandleHeaderContents(handle: Readonly<CompilerCppCAbiHandlePlan>): string {
  const guard = `FLIGHT_CPP_C_ABI_${handle.carrier.toUpperCase()}_HANDLE_H`;
  return [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
    ...visibilityMacroLines,
    '',
    `struct ${handle.carrier};`,
    '',
    '#if defined(__cplusplus)',
    'extern "C" {',
    '#endif',
    '',
    `FLIGHT_CPP_API struct ${handle.carrier}* ${handle.retainSymbol}(struct ${handle.carrier}* handle);`,
    `FLIGHT_CPP_API void ${handle.releaseSymbol}(struct ${handle.carrier}* handle);`,
    '',
    '#if defined(__cplusplus)',
    '}',
    '#endif',
    '',
    `#endif /* ${guard} */`,
    '',
  ].join('\n');
}

function emitHandleAdapterSourceContents(handle: Readonly<CompilerCppCAbiHandlePlan>): string {
  return [
    '#include <atomic>',
    '#include <cstddef>',
    '#include <utility>',
    '',
    `#include <${handle.header}>`,
    '',
    `struct ${handle.carrier} final {`,
    `  std::atomic<std::size_t> references{${handle.lifecycle.initialReferences}};`,
    `  ${handle.cppOwnerCarrier} owner;`,
    '',
    `  explicit ${handle.carrier}(${handle.cppOwnerCarrier} value)`,
    '      : owner(std::move(value)) {}',
    '};',
    '',
    `const ${handle.cppOwnerCarrier}& ${handle.borrowSymbol}(const struct ${handle.carrier}* handle) noexcept {`,
    '  return handle->owner;',
    '}',
    '',
    `struct ${handle.carrier}* ${handle.createOwnedSymbol}(${handle.cppOwnerCarrier} owner) {`,
    '  if (!owner) {',
    '    return nullptr;',
    '  }',
    `  return new ${handle.carrier}(std::move(owner));`,
    '}',
    '',
    `extern "C" FLIGHT_CPP_API struct ${handle.carrier}* ${handle.retainSymbol}(struct ${handle.carrier}* handle) {`,
    '  if (handle == nullptr) {',
    '    return nullptr;',
    '  }',
    '  handle->references.fetch_add(1, std::memory_order_relaxed);',
    '  return handle;',
    '}',
    '',
    `extern "C" FLIGHT_CPP_API void ${handle.releaseSymbol}(struct ${handle.carrier}* handle) {`,
    '  if (handle == nullptr) {',
    '    return;',
    '  }',
    '  if (handle->references.fetch_sub(1, std::memory_order_acq_rel) == 1) {',
    '    delete handle;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function emitFunctionHeaderContents(plan: FunctionEmissionPlan): string {
  const { function: functionPlan } = plan;
  const guard = `FLIGHT_CPP_C_ABI_${functionPlan.symbol.toUpperCase()}_H`;
  const handles = collectFunctionHandles(plan);
  const records = collectFunctionRecords(plan);
  const lines = [
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
    '#include <stdbool.h>',
    '',
    ...visibilityMacroLines,
    '',
    '#ifndef FLIGHT_CPP_ABI_V1_STATUS_DEFINED',
    '#define FLIGHT_CPP_ABI_V1_STATUS_DEFINED',
    'typedef enum flight_cpp_status {',
    `  ${functionPlan.error.successConstant} = 0,`,
    `  ${functionPlan.error.invalidArgumentConstant} = 1,`,
    `  ${functionPlan.error.exceptionConstant} = 2`,
    '} flight_cpp_status;',
    '#endif',
  ];
  if (handles.length > 0) {
    lines.push('', ...handles.map((handle) => `struct ${handle.carrier};`));
  }
  for (const record of records) lines.push('', ...emitRecordDefinitionLines(record));
  lines.push(
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
  );
  return lines.join('\n');
}

function emitFunctionAdapterSourceContents(plan: FunctionEmissionPlan): string {
  const { function: functionPlan } = plan;
  const handles = collectFunctionHandles(plan);
  const records = collectFunctionRecords(plan);
  const inferredParameters = plan.parameters.filter(
    (parameter): parameter is HandleParameterPlan | RecordParameterPlan =>
      parameter.kind === 'record' ||
      (parameter.kind === 'handle' &&
        (parameter.parameter.adapter === 'borrow-readonly-handle' || parameter.parameter.presence !== 'required')),
  );
  const usesOptional =
    records.length > 0 ||
    plan.parameters.some((parameter) => parameter.kind === 'handle' && parameter.parameter.presence !== 'required') ||
    (plan.result.kind === 'handle' && plan.result.presence !== 'required');
  const standardHeaders = [
    ...(inferredParameters.length > 0 ? ['cstddef'] : []),
    ...(usesOptional ? ['optional'] : []),
    ...(inferredParameters.length > 0 ? ['tuple', 'type_traits'] : []),
  ];
  const lines = [
    ...standardHeaders.map((header) => `#include <${header}>`),
    ...(standardHeaders.length > 0 ? [''] : []),
    `#include <${functionPlan.header}>`,
  ];
  if (handles.length > 0) {
    lines.push('', ...handles.map((handle) => `struct ${handle.carrier};`));
    for (const handle of handles) {
      if (!plan.parameters.some((parameter) => parameter.kind === 'handle' && parameter.handle === handle)) continue;
      lines.push(
        `const ${handle.cppOwnerCarrier}& ${handle.borrowSymbol}(const struct ${handle.carrier}* handle) noexcept;`,
      );
    }
    if (plan.result.kind === 'handle') {
      lines.push(
        `struct ${plan.result.handle.carrier}* ${plan.result.handle.createOwnedSymbol}(${plan.result.handle.cppOwnerCarrier} owner);`,
      );
    }
  }
  for (const record of records) lines.push('', ...emitRecordDefinitionLines(record));
  if (inferredParameters.length > 0) {
    lines.push(
      '',
      'template <std::size_t Position, typename Result, typename... Arguments>',
      'auto flight_cpp_adapter_argument_type(Result (*)(Arguments...))',
      '    -> std::tuple_element_t<Position, std::tuple<Arguments...>>;',
    );
    for (const parameter of inferredParameters) {
      const position = parameter.parameter.position;
      lines.push(
        '',
        `using flight_cpp_adapter_argument_${position} = std::remove_cvref_t<decltype(flight_cpp_adapter_argument_type<${position}>(&${functionPlan.cppTarget}))>;`,
      );
      if (parameter.kind === 'record') {
        lines.push(
          `using flight_cpp_adapter_argument_${position}_element = typename flight_cpp_adapter_argument_${position}::element_type;`,
        );
      }
    }
  }
  lines.push('', `extern "C" ${emitFunctionSignature(plan)} {`);
  if (plan.result.kind !== 'void') {
    lines.push('  if (out_result != nullptr) {');
    if (plan.result.kind === 'record') {
      for (const member of plan.result.record.members) {
        if (member.presence === 'explicit-flag') lines.push(`    out_result->${member.hasName} = false;`);
        lines.push(`    out_result->${member.name} = ${member.initialization};`);
      }
    } else {
      lines.push(`    *out_result = ${plan.result.kind === 'scalar' ? plan.result.initialization : 'nullptr'};`);
    }
    lines.push(
      '  }',
      '  if (out_result == nullptr) {',
      `    return ${functionPlan.error.invalidArgumentConstant};`,
      '  }',
    );
  }
  for (const parameter of plan.parameters) {
    if (parameter.kind === 'scalar') continue;
    if (parameter.kind === 'handle' && parameter.parameter.presence !== 'required') continue;
    lines.push(
      `  if (${parameter.parameter.name} == nullptr) {`,
      `    return ${functionPlan.error.invalidArgumentConstant};`,
      '  }',
    );
  }
  const arguments_ = plan.parameters.map((parameter) => emitFunctionArgument(parameter)).join(', ');
  lines.push('  try {');
  if (plan.result.kind === 'scalar') {
    lines.push(`    *out_result = ${functionPlan.cppTarget}(${arguments_});`);
  } else if (plan.result.kind === 'handle') {
    if (plan.result.presence !== 'required') {
      const result = 'flight_cpp_adapter_result.value()';
      const owner =
        plan.result.adapter === 'recover-readonly-owner-handle-to-out'
          ? `flight::structural_ref_cast<${plan.result.handle.cppOwnerCarrier}>(${result})`
          : result;
      lines.push(
        `    const auto flight_cpp_adapter_result = ${functionPlan.cppTarget}(${arguments_});`,
        '    if (flight_cpp_adapter_result.has_value()) {',
        `      *out_result = ${plan.result.handle.createOwnedSymbol}(${owner});`,
        '    }',
      );
    } else if (plan.result.adapter === 'recover-readonly-owner-handle-to-out') {
      lines.push(
        `    const auto flight_cpp_adapter_result = ${functionPlan.cppTarget}(${arguments_});`,
        `    *out_result = ${plan.result.handle.createOwnedSymbol}(flight::structural_ref_cast<${plan.result.handle.cppOwnerCarrier}>(flight_cpp_adapter_result));`,
      );
    } else {
      lines.push(
        `    *out_result = ${plan.result.handle.createOwnedSymbol}(${functionPlan.cppTarget}(${arguments_}));`,
      );
    }
  } else if (plan.result.kind === 'record') {
    lines.push(`    const auto flight_cpp_adapter_result = ${functionPlan.cppTarget}(${arguments_});`);
    for (const member of plan.result.record.members) {
      if (member.presence === 'explicit-flag') {
        lines.push(
          `    out_result->${member.hasName} = flight_cpp_adapter_result->${member.cppName}.has_value();`,
          `    out_result->${member.name} = flight_cpp_adapter_result->${member.cppName}.value_or(${member.initialization});`,
        );
      } else {
        lines.push(`    out_result->${member.name} = flight_cpp_adapter_result->${member.cppName};`);
      }
    }
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

function emitFunctionSignature(plan: FunctionEmissionPlan): string {
  const parameters = plan.parameters.map(({ parameter }) => `${parameter.carrier} ${parameter.name}`);
  if (plan.result.kind === 'scalar') parameters.push(`${plan.result.carrier} out_result`);
  if (plan.result.kind === 'handle') parameters.push(`struct ${plan.result.handle.carrier}** out_result`);
  if (plan.result.kind === 'record') parameters.push(`struct ${plan.result.record.carrier}* out_result`);
  return `${plan.function.visibility} ${plan.function.error.statusCarrier} ${plan.function.symbol}(${parameters.length > 0 ? parameters.join(', ') : 'void'})`;
}

function emitFunctionArgument(parameter: EmissionParameterPlan): string {
  if (parameter.kind === 'handle') {
    const borrowed = `${parameter.handle.borrowSymbol}(${parameter.parameter.name})`;
    const present =
      parameter.parameter.adapter === 'borrow-readonly-handle'
        ? `flight_cpp_adapter_argument_${parameter.parameter.position}{${borrowed}}`
        : borrowed;
    return parameter.parameter.presence === 'required'
      ? present
      : `${parameter.parameter.name} == nullptr ? flight_cpp_adapter_argument_${parameter.parameter.position}{std::nullopt} : flight_cpp_adapter_argument_${parameter.parameter.position}{${borrowed}}`;
  }
  if (parameter.kind === 'scalar') return parameter.parameter.name;
  const members = parameter.record.members.map((member) => {
    const value = `${parameter.parameter.name}->${member.name}`;
    return member.presence === 'explicit-flag'
      ? `.${member.cppName} = ${parameter.parameter.name}->${member.hasName} ? std::optional<${member.carrier}>{${value}} : std::nullopt`
      : `.${member.cppName} = ${value}`;
  });
  const position = parameter.parameter.position;
  return `flight::make_ref<flight_cpp_adapter_argument_${position}_element>(flight_cpp_adapter_argument_${position}_element{${members.join(', ')}})`;
}

function collectFunctionHandles(plan: FunctionEmissionPlan): readonly Readonly<CompilerCppCAbiHandlePlan>[] {
  const handles = new Map<string, Readonly<CompilerCppCAbiHandlePlan>>();
  for (const parameter of plan.parameters) {
    if (parameter.kind === 'handle') handles.set(parameter.handle.carrier, parameter.handle);
  }
  if (plan.result.kind === 'handle') handles.set(plan.result.handle.carrier, plan.result.handle);
  return [...handles.values()].sort((left, right) => compareTextCodeUnits(left.carrier, right.carrier));
}

function collectFunctionRecords(plan: FunctionEmissionPlan): readonly Readonly<CompilerCppCAbiRecordPlan>[] {
  const records = new Map<string, Readonly<CompilerCppCAbiRecordPlan>>();
  for (const parameter of plan.parameters) {
    if (parameter.kind === 'record') records.set(parameter.record.carrier, parameter.record);
  }
  if (plan.result.kind === 'record') records.set(plan.result.record.carrier, plan.result.record);
  return [...records.values()].sort((left, right) => compareTextCodeUnits(left.carrier, right.carrier));
}

function reserveSymbol(symbols: Set<string>, identity: EmissionFailureIdentity, symbol: string): void {
  if (symbols.has(symbol)) {
    throw createCompilerCppCAbiEmissionFailure(identity, 'invalid-plan', `C ABI plan repeats global symbol ${symbol}`);
  }
  symbols.add(symbol);
}

function handleIdentity(handle: Readonly<CompilerCppCAbiHandlePlan>): EmissionFailureIdentity {
  return {
    bindingId: handle.bindingId,
    packageName: handle.packageName,
    source: handle.source,
    symbol: handle.retainSymbol,
  };
}

function recordIdentity(record: Readonly<CompilerCppCAbiRecordPlan>): EmissionFailureIdentity {
  return {
    bindingId: record.bindingId,
    packageName: record.packageName,
    source: record.source,
    symbol: record.carrier,
  };
}

function createCompilerCppCAbiEmissionFailure(
  identity: EmissionFailureIdentity | undefined,
  code: CompilerCppCAbiEmissionFailureCode,
  message: string,
): CompilerCppCAbiEmissionFailure {
  const failure = Object.assign(new Error(message), {
    bindingId: identity?.bindingId ?? '',
    code,
    kind: 'cpp-c-abi-emission' as const,
    packageName: identity?.packageName ?? '',
    source: identity?.source ?? '',
    symbol: identity?.symbol ?? '',
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

function isCppHeaderPath(value: string): boolean {
  return (
    value.length > 2 &&
    (value.endsWith('.h') || value.endsWith('.hpp')) &&
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

const visibilityMacroLines = [
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
] as const;

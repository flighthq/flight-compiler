import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
  CppCompilerRuntimeProfile,
} from '../../compiler-types/src/index.js';

type CppRuntimeExternalSymbolBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'native' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'runtime' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>;

export function createCompilerRuntimeExternalSymbolBindingPlanCpp(
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: getCppRuntimeExternalSymbolBindings(runtimeProfile).map((binding) =>
      binding.kind === 'runtime'
        ? {
            capability: binding.capability,
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          }
        : {
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          },
    ),
    contract: 'flight-runtime-contract/2',
  };
}

export function getCompilerRuntimeExternalMemberTargetCpp(
  sourceName: string,
  member: string,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: CppRuntimeExternalSymbolBinding | undefined = getCppRuntimeExternalSymbolBindings(runtimeProfile).find(
    (candidate) => candidate.sourceName === normalized && candidate.space === 'value',
  );
  if (!binding) return undefined;
  return binding.members?.find((candidate) => candidate.sourceMember === member.normalize('NFC'))?.targetName;
}

export function getCompilerRuntimeExternalSymbolTargetCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return getCppRuntimeExternalSymbolBindings(runtimeProfile).find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

export function isCompilerRuntimeExternalSymbolProvidedCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
): boolean {
  const normalized = sourceName.normalize('NFC');
  return (
    getCppRuntimeExternalSymbolBindings(runtimeProfile).find(
      (candidate) => candidate.sourceName === normalized && candidate.space === space,
    )?.kind === 'runtime'
  );
}

function getCppRuntimeExternalSymbolBindings(
  runtimeProfile: CppCompilerRuntimeProfile,
): readonly CppRuntimeExternalSymbolBinding[] {
  return runtimeProfile === 'flight-cpp' ? cppFlightRuntimeExternalSymbolBindings : cppRuntimeExternalSymbolBindings;
}

const cppFlightRuntimeExternalSymbolBindings = [
  {
    kind: 'native',
    members: [
      { sourceMember: 'E', targetName: 'flight::e' },
      { sourceMember: 'PI', targetName: 'flight::pi' },
      { sourceMember: 'abs', targetName: 'std::abs' },
      { sourceMember: 'ceil', targetName: 'std::ceil' },
      { sourceMember: 'cos', targetName: 'std::cos' },
      { sourceMember: 'floor', targetName: 'std::floor' },
      { sourceMember: 'max', targetName: 'flight::maximum' },
      { sourceMember: 'min', targetName: 'flight::minimum' },
      { sourceMember: 'pow', targetName: 'flight::power' },
      { sourceMember: 'round', targetName: 'flight::round' },
      { sourceMember: 'sign', targetName: 'flight::sign' },
      { sourceMember: 'sin', targetName: 'std::sin' },
      { sourceMember: 'sqrt', targetName: 'std::sqrt' },
      { sourceMember: 'trunc', targetName: 'std::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'cmath',
  },
  { capability: 'array', kind: 'runtime', sourceName: 'Array', space: 'type', targetName: 'flight::Array' },
  {
    capability: 'array',
    kind: 'runtime',
    members: [{ sourceMember: 'isArray', targetName: 'flight::is_array' }],
    sourceName: 'Array',
    space: 'value',
    targetName: 'flight::Array',
  },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'flight::Date' },
  {
    capability: 'date',
    kind: 'runtime',
    members: [{ sourceMember: 'now', targetName: 'flight::Date::now' }],
    sourceName: 'Date',
    space: 'value',
    targetName: 'flight::Date',
  },
  { capability: 'error', kind: 'runtime', sourceName: 'Error', space: 'type', targetName: 'flight::Error' },
  { capability: 'error', kind: 'runtime', sourceName: 'Error', space: 'value', targetName: 'flight::Error' },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'type',
    targetName: 'flight::Float32Array',
  },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'value',
    targetName: 'flight::Float32Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'type',
    targetName: 'flight::Float64Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'value',
    targetName: 'flight::Float64Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'type',
    targetName: 'flight::Int16Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'value',
    targetName: 'flight::Int16Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'type',
    targetName: 'flight::Int32Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'value',
    targetName: 'flight::Int32Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'type',
    targetName: 'flight::Int8Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'value',
    targetName: 'flight::Int8Array',
  },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'type', targetName: 'flight::Map' },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'value', targetName: 'flight::Map' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'flight::Task' },
  {
    capability: 'task',
    kind: 'runtime',
    members: [
      { sourceMember: 'all', targetName: 'flight::all_tasks' },
      { sourceMember: 'reject', targetName: 'flight::reject_task' },
      { sourceMember: 'resolve', targetName: 'flight::resolve_task' },
    ],
    sourceName: 'Promise',
    space: 'value',
    targetName: 'flight::Task',
  },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'type', targetName: 'flight::Set' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'value', targetName: 'flight::Set' },
  { capability: 'string', kind: 'runtime', sourceName: 'String', space: 'type', targetName: 'flight::String' },
  {
    capability: 'string',
    kind: 'runtime',
    members: [{ sourceMember: 'fromCharCode', targetName: 'flight::String::from_char_code' }],
    sourceName: 'String',
    space: 'value',
    targetName: 'flight::String',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'type',
    targetName: 'flight::Uint16Array',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'value',
    targetName: 'flight::Uint16Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'type',
    targetName: 'flight::Uint32Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'value',
    targetName: 'flight::Uint32Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'type',
    targetName: 'flight::Uint8Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'value',
    targetName: 'flight::Uint8Array',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'type',
    targetName: 'flight::Uint8ClampedArray',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'value',
    targetName: 'flight::Uint8ClampedArray',
  },
  { capability: 'weak-map', kind: 'runtime', sourceName: 'WeakMap', space: 'type', targetName: 'flight::WeakMap' },
  {
    capability: 'weak-map',
    kind: 'runtime',
    sourceName: 'WeakMap',
    space: 'value',
    targetName: 'flight::WeakMap',
  },
] as const satisfies readonly CppRuntimeExternalSymbolBinding[];

const cppRuntimeExternalSymbolBindings = [
  {
    kind: 'native',
    members: [
      { sourceMember: 'E', targetName: 'M_E' },
      { sourceMember: 'PI', targetName: 'M_PI' },
      { sourceMember: 'abs', targetName: 'std::abs' },
      { sourceMember: 'ceil', targetName: 'std::ceil' },
      { sourceMember: 'cos', targetName: 'std::cos' },
      { sourceMember: 'floor', targetName: 'std::floor' },
      { sourceMember: 'max', targetName: 'std::max' },
      { sourceMember: 'min', targetName: 'std::min' },
      { sourceMember: 'pow', targetName: 'std::pow' },
      { sourceMember: 'round', targetName: 'std::round' },
      { sourceMember: 'sign', targetName: 'flight::sign' },
      { sourceMember: 'sin', targetName: 'std::sin' },
      { sourceMember: 'sqrt', targetName: 'std::sqrt' },
      { sourceMember: 'trunc', targetName: 'std::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'cmath',
  },
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'std::vector' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'std::vector' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'FlightDate' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: 'FlightDate' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'Float32Array', space: 'type', targetName: 'std::vector<float>' },
  { kind: 'native', sourceName: 'Float32Array', space: 'value', targetName: 'std::vector<float>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'type', targetName: 'std::vector<double>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'value', targetName: 'std::vector<double>' },
  { kind: 'native', sourceName: 'Int16Array', space: 'type', targetName: 'std::vector<int16_t>' },
  { kind: 'native', sourceName: 'Int16Array', space: 'value', targetName: 'std::vector<int16_t>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'type', targetName: 'std::vector<int32_t>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'value', targetName: 'std::vector<int32_t>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'type', targetName: 'std::vector<int8_t>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'value', targetName: 'std::vector<int8_t>' },
  { kind: 'native', sourceName: 'Map', space: 'type', targetName: 'std::unordered_map' },
  { kind: 'native', sourceName: 'Map', space: 'value', targetName: 'std::unordered_map' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'FlightTask' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'value', targetName: 'FlightTask' },
  { kind: 'native', sourceName: 'Set', space: 'type', targetName: 'std::unordered_set' },
  { kind: 'native', sourceName: 'Set', space: 'value', targetName: 'std::unordered_set' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'type', targetName: 'std::vector<uint16_t>' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'value', targetName: 'std::vector<uint16_t>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'type', targetName: 'std::vector<uint32_t>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'value', targetName: 'std::vector<uint32_t>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'type', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'value', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'type', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'value', targetName: 'std::vector<uint8_t>' },
] as const satisfies readonly CppRuntimeExternalSymbolBinding[];

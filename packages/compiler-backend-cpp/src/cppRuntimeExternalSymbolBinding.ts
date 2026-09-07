import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
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
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
    }>;

export function createCompilerRuntimeExternalSymbolBindingPlanCpp(): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: cppRuntimeExternalSymbolBindings.map((binding) =>
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

export function getCompilerRuntimeExternalMemberTargetCpp(sourceName: string, member: string): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: CppRuntimeExternalSymbolBinding | undefined = cppRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === 'value',
  );
  if (!binding || binding.kind !== 'native') return undefined;
  return binding.members?.find((candidate) => candidate.sourceMember === member.normalize('NFC'))?.targetName;
}

export function getCompilerRuntimeExternalSymbolTargetCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return cppRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

export function isCompilerRuntimeExternalSymbolProvidedCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
): boolean {
  const normalized = sourceName.normalize('NFC');
  return (
    cppRuntimeExternalSymbolBindings.find(
      (candidate) => candidate.sourceName === normalized && candidate.space === space,
    )?.kind === 'runtime'
  );
}

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

import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
} from '../../compiler-types/src/index.js';

type RustRuntimeExternalSymbolBinding =
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

export function createCompilerRuntimeExternalSymbolBindingPlanRust(): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: rustRuntimeExternalSymbolBindings.map((binding) =>
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

// A namespace-like ambient symbol has no single target name, so its members are spelled one at a
// time. `Math.max` is `f64::max`; there is no `Math` to name on its own.
export function getCompilerRuntimeExternalMemberTargetRust(sourceName: string, member: string): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: RustRuntimeExternalSymbolBinding | undefined = rustRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === 'value',
  );
  if (!binding || binding.kind !== 'native') return undefined;
  return binding.members?.find((candidate) => candidate.sourceMember === member.normalize('NFC'))?.targetName;
}

export function getCompilerRuntimeExternalSymbolTargetRust(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return rustRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

// Whether the runtime crate provides this symbol, as opposed to Rust itself. `Promise` becomes a
// type the runtime defines and has to be imported; `Map` becomes `std::collections::HashMap`, which
// is already there. Only the first kind belongs in a `use` of the runtime crate.
export function isCompilerRuntimeExternalSymbolProvidedRust(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
): boolean {
  const normalized = sourceName.normalize('NFC');
  return (
    rustRuntimeExternalSymbolBindings.find(
      (candidate) => candidate.sourceName === normalized && candidate.space === space,
    )?.kind === 'runtime'
  );
}

const rustRuntimeExternalSymbolBindings = [
  {
    kind: 'native',
    members: [
      { sourceMember: 'abs', targetName: 'f64::abs' },
      { sourceMember: 'floor', targetName: 'f64::floor' },
      { sourceMember: 'max', targetName: 'f64::max' },
      { sourceMember: 'min', targetName: 'f64::min' },
      { sourceMember: 'round', targetName: 'f64::round' },
      { sourceMember: 'sqrt', targetName: 'f64::sqrt' },
      { sourceMember: 'trunc', targetName: 'f64::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'f64',
  },
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'FlightDate' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: 'FlightDate' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'Error' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'Error' },
  { kind: 'native', sourceName: 'Float32Array', space: 'type', targetName: 'Vec<f32>' },
  { kind: 'native', sourceName: 'Float32Array', space: 'value', targetName: 'Vec<f32>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'type', targetName: 'Vec<f64>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'value', targetName: 'Vec<f64>' },
  { kind: 'native', sourceName: 'Int16Array', space: 'type', targetName: 'Vec<i16>' },
  { kind: 'native', sourceName: 'Int16Array', space: 'value', targetName: 'Vec<i16>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'type', targetName: 'Vec<i32>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'value', targetName: 'Vec<i32>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'type', targetName: 'Vec<i8>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'value', targetName: 'Vec<i8>' },
  { kind: 'native', sourceName: 'Map', space: 'type', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'Map', space: 'value', targetName: 'std::collections::HashMap' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'FlightTask' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'value', targetName: 'FlightTask' },
  { kind: 'native', sourceName: 'Set', space: 'type', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'Set', space: 'value', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'type', targetName: 'Vec<u16>' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'value', targetName: 'Vec<u16>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'type', targetName: 'Vec<u32>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'value', targetName: 'Vec<u32>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'type', targetName: 'Vec<u8>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'value', targetName: 'Vec<u8>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'type', targetName: 'Vec<u8>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'value', targetName: 'Vec<u8>' },
] as const satisfies readonly RustRuntimeExternalSymbolBinding[];

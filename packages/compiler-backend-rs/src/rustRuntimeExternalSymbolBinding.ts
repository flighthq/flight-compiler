import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
} from '../../compiler-types/src/index.js';

type RustRuntimeExternalSymbolBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'native' }>['kind'];
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

export function getCompilerRuntimeExternalSymbolTargetRust(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return rustRuntimeExternalSymbolBindings.find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

const rustRuntimeExternalSymbolBindings = [
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
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

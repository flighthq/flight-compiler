import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
  RustCompilerExternalBinding,
  RustCompilerExternalBindingManifest,
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

export function createCompilerRuntimeExternalSymbolBindingPlanRust(
  externalBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: getRustRuntimeExternalSymbolBindings(externalBindings).map((binding) =>
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
export function getCompilerRuntimeExternalMemberTargetRust(
  sourceName: string,
  member: string,
  externalBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: RustRuntimeExternalSymbolBinding | undefined = getRustRuntimeExternalSymbolBindings(
    externalBindings,
  ).find((candidate) => candidate.sourceName === normalized && candidate.space === 'value');
  if (!binding || binding.kind !== 'native') return undefined;
  return binding.members?.find((candidate) => candidate.sourceMember === member.normalize('NFC'))?.targetName;
}

export function getCompilerRuntimeExternalSymbolTargetRust(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  externalBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return getRustRuntimeExternalSymbolBindings(externalBindings).find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

// Whether the runtime crate provides this symbol, as opposed to Rust itself. `Promise` becomes a
// type the runtime defines and has to be imported; `Map` becomes `std::collections::HashMap`, which
// is already there. Only the first kind belongs in a `use` of the runtime crate.
export function isCompilerRuntimeExternalSymbolProvidedRust(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  externalBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): boolean {
  const normalized = sourceName.normalize('NFC');
  return (
    getRustRuntimeExternalSymbolBindings(externalBindings).find(
      (candidate) => candidate.sourceName === normalized && candidate.space === space,
    )?.kind === 'runtime'
  );
}

function getRustRuntimeExternalSymbolBindings(
  externalBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): readonly RustRuntimeExternalSymbolBinding[] {
  return [
    ...rustRuntimeExternalSymbolBindings,
    ...getRustCompilerExternalBindings(externalBindings).map(
      (binding): RustRuntimeExternalSymbolBinding => ({
        kind: 'native',
        ...(binding.members ? { members: binding.members } : {}),
        sourceName: binding.sourceName,
        space: binding.space,
        targetName: binding.targetName,
      }),
    ),
  ];
}

function getRustCompilerExternalBindings(
  manifest?: Readonly<RustCompilerExternalBindingManifest> | undefined,
): readonly Readonly<RustCompilerExternalBinding>[] {
  if (!manifest) return [];
  if (manifest.schema !== 'flight-rust-external-bindings/1' || !Array.isArray(manifest.bindings)) {
    throw new TypeError('Rust external bindings require flight-rust-external-bindings/1');
  }
  return manifest.bindings.map((binding: Readonly<RustCompilerExternalBinding>, index: number) => {
    const subject = `Rust external binding ${String(index)}`;
    if (
      !binding ||
      typeof binding.sourceName !== 'string' ||
      binding.sourceName.length === 0 ||
      (binding.space !== 'type' && binding.space !== 'value') ||
      typeof binding.targetName !== 'string' ||
      binding.targetName.length === 0 ||
      (binding.nullability !== 'non-null' && binding.nullability !== 'nullable') ||
      !rustExternalBindingOwnerships.has(binding.ownership)
    ) {
      throw new TypeError(`${subject} is malformed`);
    }
    if (
      binding.members?.some(
        (member: Readonly<{ sourceMember: string; targetName: string }>) =>
          !member ||
          typeof member.sourceMember !== 'string' ||
          member.sourceMember.length === 0 ||
          typeof member.targetName !== 'string' ||
          member.targetName.length === 0,
      )
    ) {
      throw new TypeError(`${subject} has malformed static-member mappings`);
    }
    return {
      ...(binding.members
        ? {
            members: binding.members.map((member: Readonly<{ sourceMember: string; targetName: string }>) => ({
              ...member,
            })),
          }
        : {}),
      nullability: binding.nullability,
      ownership: binding.ownership,
      sourceName: binding.sourceName.normalize('NFC'),
      space: binding.space,
      targetName: binding.targetName,
    };
  });
}

const rustExternalBindingOwnerships = new Set<RustCompilerExternalBinding['ownership']>([
  'borrowed',
  'owned',
  'shared',
  'value',
]);

const rustRuntimeExternalSymbolBindings = [
  {
    kind: 'native',
    members: [
      { sourceMember: 'E', targetName: 'std::f64::consts::E' },
      { sourceMember: 'PI', targetName: 'std::f64::consts::PI' },
      { sourceMember: 'SQRT1_2', targetName: 'std::f64::consts::FRAC_1_SQRT_2' },
      { sourceMember: 'SQRT2', targetName: 'std::f64::consts::SQRT_2' },
      { sourceMember: 'abs', targetName: 'f64::abs' },
      { sourceMember: 'acos', targetName: 'f64::acos' },
      { sourceMember: 'asin', targetName: 'f64::asin' },
      { sourceMember: 'atan', targetName: 'f64::atan' },
      { sourceMember: 'atan2', targetName: 'f64::atan2' },
      { sourceMember: 'cbrt', targetName: 'f64::cbrt' },
      { sourceMember: 'ceil', targetName: 'f64::ceil' },
      { sourceMember: 'cos', targetName: 'f64::cos' },
      { sourceMember: 'exp', targetName: 'f64::exp' },
      { sourceMember: 'floor', targetName: 'f64::floor' },
      { sourceMember: 'hypot', targetName: 'f64::hypot' },
      { sourceMember: 'log', targetName: 'f64::ln' },
      { sourceMember: 'log10', targetName: 'f64::log10' },
      { sourceMember: 'log2', targetName: 'f64::log2' },
      { sourceMember: 'max', targetName: 'f64::max' },
      { sourceMember: 'min', targetName: 'f64::min' },
      { sourceMember: 'pow', targetName: 'f64::powf' },
      { sourceMember: 'round', targetName: 'flight_runtime::round' },
      { sourceMember: 'sign', targetName: 'f64::signum' },
      { sourceMember: 'sin', targetName: 'f64::sin' },
      { sourceMember: 'sqrt', targetName: 'f64::sqrt' },
      { sourceMember: 'tan', targetName: 'f64::tan' },
      { sourceMember: 'trunc', targetName: 'f64::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'f64',
  },
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'Vec' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'Vec' },
  { kind: 'native', sourceName: 'ArrayLike', space: 'type', targetName: 'Vec' },
  { kind: 'native', sourceName: 'ArrayBuffer', space: 'type', targetName: 'Vec<u8>' },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'FlightDate' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: 'FlightDate' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'Error' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'Error' },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'type',
    targetName: 'FlightFloat32Array',
  },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'value',
    targetName: 'FlightFloat32Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'type',
    targetName: 'FlightFloat64Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'value',
    targetName: 'FlightFloat64Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'type',
    targetName: 'FlightInt16Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'value',
    targetName: 'FlightInt16Array',
  },
  { kind: 'native', sourceName: 'Infinity', space: 'value', targetName: 'f64::INFINITY' },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'type',
    targetName: 'FlightInt32Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'value',
    targetName: 'FlightInt32Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'type',
    targetName: 'FlightInt8Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'value',
    targetName: 'FlightInt8Array',
  },
  { kind: 'native', sourceName: 'Map', space: 'type', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'Map', space: 'value', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'NaN', space: 'value', targetName: 'f64::NAN' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'FlightTask' },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'value', targetName: 'FlightTask' },
  { kind: 'native', sourceName: 'RangeError', space: 'type', targetName: 'Error' },
  { kind: 'native', sourceName: 'RangeError', space: 'value', targetName: 'Error' },
  { kind: 'native', sourceName: 'ReadonlyMap', space: 'type', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'ReadonlySet', space: 'type', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'Record', space: 'type', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'Set', space: 'type', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'Set', space: 'value', targetName: 'std::collections::HashSet' },
  { kind: 'native', sourceName: 'String', space: 'type', targetName: 'String' },
  { kind: 'native', sourceName: 'String', space: 'value', targetName: 'String' },
  { kind: 'native', sourceName: 'TypeError', space: 'type', targetName: 'Error' },
  { kind: 'native', sourceName: 'TypeError', space: 'value', targetName: 'Error' },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'type',
    targetName: 'FlightUint16Array',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'value',
    targetName: 'FlightUint16Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'type',
    targetName: 'FlightUint32Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'value',
    targetName: 'FlightUint32Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'type',
    targetName: 'FlightUint8Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'value',
    targetName: 'FlightUint8Array',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'type',
    targetName: 'FlightUint8ClampedArray',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'value',
    targetName: 'FlightUint8ClampedArray',
  },
  { kind: 'native', sourceName: 'WeakMap', space: 'type', targetName: 'std::collections::HashMap' },
  { kind: 'native', sourceName: 'WeakMap', space: 'value', targetName: 'std::collections::HashMap' },
] as const satisfies readonly RustRuntimeExternalSymbolBinding[];

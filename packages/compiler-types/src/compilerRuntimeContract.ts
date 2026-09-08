// Runtime capabilities name what the ambient runtime surface must provide. Host concerns do not
// belong here: the host lane is discovered and registered explicitly, and a target's representation
// for an opaque host value is a backend option (`opaqueHostType`), not a runtime capability.
//
// Every name here is elected by at least one backend binding table. A capability no target binds
// cannot say whether a symbol is unsupported or merely unmet, which is the ambiguity the foundations
// audit warns about, so aspirational names are removed until a demonstrated target path returns them.
export type CompilerRuntimeCapabilityName =
  | 'array'
  | 'date'
  | 'error'
  | 'float32-array'
  | 'float64-array'
  | 'int8-array'
  | 'int16-array'
  | 'int32-array'
  | 'map'
  | 'set'
  | 'string'
  | 'task'
  | 'uint8-array'
  | 'uint8-clamped-array'
  | 'uint16-array'
  | 'uint32-array';

export type CompilerRuntimeContractVersion = 'flight-runtime-contract/2';

export type CompilerRuntimeExternalConstructorAbiContractVersion = 'flight-runtime-constructor-abi/1';

export type CompilerRuntimeExternalSymbolSpace = 'type' | 'value';

export interface CompilerRuntimeExternalSymbolIdentity {
  readonly sourceName: string;
  readonly space: CompilerRuntimeExternalSymbolSpace;
}

export interface CompilerRuntimeExternalConstructorIdentity {
  readonly sourceName: string;
  readonly space: 'value';
}

export interface CompilerRuntimeExternalConstructorAbi {
  readonly dynamicArguments: boolean;
  readonly externalSymbol: CompilerRuntimeExternalConstructorIdentity;
  readonly fixedArgumentCounts: readonly number[];
}

export interface CompilerRuntimeExternalConstructorAbiPlan {
  readonly constructors: readonly CompilerRuntimeExternalConstructorAbi[];
  readonly contract: CompilerRuntimeExternalConstructorAbiContractVersion;
}

export interface CompilerRuntimeExternalConstructorInvocation {
  readonly externalSymbol: CompilerRuntimeExternalConstructorIdentity;
  readonly providedArgumentCount: number | 'dynamic';
}

export interface CompilerRuntimeExternalConstructorAbiContractMismatchFailure extends Error {
  readonly expected: CompilerRuntimeExternalConstructorAbiContractVersion;
  readonly kind: 'runtime-external-constructor-abi-contract-mismatch';
  readonly received: string;
}

export type CompilerRuntimeExternalConstructorAbiCompleteness =
  | Readonly<{
      contract: CompilerRuntimeExternalConstructorAbiContractVersion;
      kind: 'complete';
      requiredExternalConstructors: readonly CompilerRuntimeExternalConstructorInvocation[];
      schema: 'flight-runtime-constructor-abi-completeness/1';
    }>
  | Readonly<{
      contract: CompilerRuntimeExternalConstructorAbiContractVersion;
      duplicateExternalConstructors: readonly CompilerRuntimeExternalConstructorIdentity[];
      invalidExternalConstructors: readonly CompilerRuntimeExternalConstructorIdentity[];
      kind: 'incomplete';
      missingExternalConstructors: readonly CompilerRuntimeExternalConstructorInvocation[];
      requiredExternalConstructors: readonly CompilerRuntimeExternalConstructorInvocation[];
      schema: 'flight-runtime-constructor-abi-completeness/1';
    }>;

// How each member of an ambient symbol is spelled by a target. A binding maps one symbol to one
// target name, which fits `Array` to `Vec`. It does not fit a namespace-like symbol: `Math.max` is
// `f64::max` and `Math.PI` is a constant path, so the mapping is per member rather than per symbol.
export interface CompilerRuntimeExternalMemberBinding {
  readonly sourceMember: string;
  readonly targetName: string;
}

export type CompilerRuntimeExternalSymbolBinding =
  | Readonly<{
      externalSymbol: CompilerRuntimeExternalSymbolIdentity;
      kind: 'native';
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      externalSymbol: CompilerRuntimeExternalSymbolIdentity;
      kind: 'runtime';
    }>;

export interface CompilerRuntimeExternalSymbolBindingPlan {
  readonly bindings: readonly CompilerRuntimeExternalSymbolBinding[];
  readonly contract: CompilerRuntimeContractVersion;
}

export interface CompilerRuntimeContractMismatchFailure extends Error {
  readonly expected: CompilerRuntimeContractVersion;
  readonly kind: 'runtime-contract-mismatch';
  readonly received: string;
}

export type CompilerRuntimeExternalSymbolCompleteness =
  | Readonly<{
      contract: CompilerRuntimeContractVersion;
      kind: 'complete';
      requiredExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      schema: 'flight-runtime-contract-completeness/2';
    }>
  | Readonly<{
      contract: CompilerRuntimeContractVersion;
      duplicateExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      kind: 'incomplete';
      missingExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      requiredExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      schema: 'flight-runtime-contract-completeness/2';
    }>;

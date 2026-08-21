export type CompilerRuntimeCapabilityName =
  | 'callback'
  | 'float32-array'
  | 'float64-array'
  | 'host-value'
  | 'int8-array'
  | 'int16-array'
  | 'int32-array'
  | 'map'
  | 'set'
  | 'symbol'
  | 'task'
  | 'uint8-array'
  | 'uint8-clamped-array'
  | 'uint16-array'
  | 'uint32-array';

export type CompilerRuntimeContractVersion = 'flight-runtime-contract/2';

export type CompilerRuntimeExternalSymbolSpace = 'type' | 'value';

export interface CompilerRuntimeExternalSymbolIdentity {
  readonly sourceName: string;
  readonly space: CompilerRuntimeExternalSymbolSpace;
}

export type CompilerRuntimeExternalSymbolBinding =
  | Readonly<{
      externalSymbol: CompilerRuntimeExternalSymbolIdentity;
      kind: 'native';
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

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

export type CompilerRuntimeContractVersion = 'flight-runtime-contract/1';

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
  readonly contract: 'flight-runtime-contract/2';
}

export type CompilerRuntimeExternalSymbolCompleteness =
  | Readonly<{
      contract: 'flight-runtime-contract/2';
      kind: 'complete';
      requiredExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      schema: 'flight-runtime-contract-completeness/2';
    }>
  | Readonly<{
      contract: 'flight-runtime-contract/2';
      duplicateExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      kind: 'incomplete';
      missingExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      requiredExternalSymbols: readonly CompilerRuntimeExternalSymbolIdentity[];
      schema: 'flight-runtime-contract-completeness/2';
    }>;

export interface CompilerRuntimeExternalTypeIdentity {
  readonly sourceName: string;
}

export type CompilerRuntimeExternalTypeBinding =
  | Readonly<{
      externalType: CompilerRuntimeExternalTypeIdentity;
      kind: 'native';
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      externalType: CompilerRuntimeExternalTypeIdentity;
      kind: 'runtime';
    }>;

export interface CompilerRuntimeExternalTypeBindingPlan {
  readonly bindings: readonly CompilerRuntimeExternalTypeBinding[];
  readonly contract: CompilerRuntimeContractVersion;
}

export type CompilerRuntimeExternalTypeCompleteness =
  | Readonly<{
      contract: CompilerRuntimeContractVersion;
      kind: 'complete';
      requiredExternalTypes: readonly CompilerRuntimeExternalTypeIdentity[];
      schema: 'flight-runtime-contract-completeness/1';
    }>
  | Readonly<{
      contract: CompilerRuntimeContractVersion;
      duplicateExternalTypes: readonly CompilerRuntimeExternalTypeIdentity[];
      kind: 'incomplete';
      missingExternalTypes: readonly CompilerRuntimeExternalTypeIdentity[];
      requiredExternalTypes: readonly CompilerRuntimeExternalTypeIdentity[];
      schema: 'flight-runtime-contract-completeness/1';
    }>;

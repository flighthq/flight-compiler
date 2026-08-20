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

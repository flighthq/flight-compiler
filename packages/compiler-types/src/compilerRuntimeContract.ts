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

import type {
  CompilerHaxeAmbientMemberBindingPlan,
  CompilerRustAmbientMemberBindingPlan,
} from './compilerAmbientMemberBindingContract.js';
import type { CompilerRuntimeTaskCapabilityPlan } from './compilerRuntimeTaskCapabilityContract.js';

// Runtime capabilities name what the ambient runtime surface must provide. Host concerns do not
// belong here: the host lane is discovered and registered explicitly, and a target's representation
// for an opaque host value is a backend option (`opaqueHostType`), not a runtime capability.
//
// Every name here is elected by at least one backend binding table. A capability no target binds
// cannot say whether a symbol is unsupported or merely unmet, which is the ambiguity the foundations
// audit warns about, so aspirational names are removed until a demonstrated target path returns them.
export type CompilerRuntimeCapabilityName =
  | 'array'
  | 'array-buffer'
  | 'async-iterable'
  | 'data-view'
  | 'date'
  | 'error'
  | 'float32-array'
  | 'float64-array'
  | 'int8-array'
  | 'int16-array'
  | 'int32-array'
  | 'internationalization'
  | 'javascript-semantics'
  | 'json'
  | 'map'
  | 'number-parsing'
  | 'object'
  | 'regexp'
  | 'record'
  | 'set'
  | 'string'
  | 'structural-proxy'
  | 'symbol'
  | 'task'
  | 'text-decoder'
  | 'uint8-array'
  | 'uint8-clamped-array'
  | 'uint16-array'
  | 'uint32-array'
  | 'url'
  | 'weak-map'
  | 'weak-set';

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
// A callable member may also carry exact target result evidence; omitting it never licenses a backend
// to infer the result from `targetName`.
export interface CompilerRuntimeExternalMemberBinding {
  readonly callResultType?: string | undefined;
  // A member a reader reaches as an INSTANCE PROPERTY rather than as a call, on a type-space binding.
  // The three fields are the whole contract for that read and are deliberately explicit: the profile
  // names the value type, how the reader stores it, and whether absence is part of the result. Nothing
  // here may be inferred -- not from where the result is used, and not from the member's name -- because
  // the source type is a library type that erased to `any` before this binding existed, so a guess is
  // indistinguishable from a fact. A read whose member omits any of them is incomplete and refuses.
  readonly propertyNullability?: 'non-null' | 'nullable' | undefined;
  readonly propertyOwnership?: 'shared' | 'value' | undefined;
  readonly propertyResultType?: string | undefined;
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

interface CompilerHaxeRuntimeExternalSymbolBindingCommon {
  readonly externalSymbol: CompilerRuntimeExternalSymbolIdentity;
  readonly members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
  readonly runtimeMembers?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
  readonly targetName: string;
}

export type CompilerHaxeRuntimeExternalSymbolBinding = CompilerHaxeRuntimeExternalSymbolBindingCommon &
  (Readonly<{ capability: CompilerRuntimeCapabilityName; kind: 'runtime' }> | Readonly<{ kind: 'native' }>);

export interface CompilerHaxeRuntimeExternalSymbolBindingPlan {
  readonly bindings: readonly CompilerHaxeRuntimeExternalSymbolBinding[];
  readonly contract: CompilerRuntimeContractVersion;
  readonly schema: 'flight-haxe-runtime-external-symbol-bindings/1';
}

interface CompilerRustRuntimeExternalSymbolBindingCommon {
  readonly externalSymbol: CompilerRuntimeExternalSymbolIdentity;
  readonly members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
  readonly targetName: string;
}

export type CompilerRustRuntimeExternalSymbolBinding = CompilerRustRuntimeExternalSymbolBindingCommon &
  (Readonly<{ capability: CompilerRuntimeCapabilityName; kind: 'runtime' }> | Readonly<{ kind: 'native' }>);

export interface CompilerRustRuntimeExternalSymbolBindingPlan {
  readonly bindings: readonly CompilerRustRuntimeExternalSymbolBinding[];
  readonly contract: CompilerRuntimeContractVersion;
  readonly schema: 'flight-rust-runtime-external-symbol-bindings/1';
}

export interface CompilerHaxeRuntimeIntrinsicRequirement {
  readonly capability: CompilerRuntimeCapabilityName;
  readonly members: readonly string[];
  readonly targetName: string;
}

export interface CompilerHaxeRuntimeIntrinsicPlan {
  readonly requirements: readonly CompilerHaxeRuntimeIntrinsicRequirement[];
  readonly schema: 'flight-haxe-runtime-intrinsics/1';
}

export interface CompilerHaxeRuntimeAbiManifest {
  readonly ambientMembers: CompilerHaxeAmbientMemberBindingPlan;
  readonly constructors: CompilerRuntimeExternalConstructorAbiPlan;
  readonly externalSymbols: CompilerHaxeRuntimeExternalSymbolBindingPlan;
  readonly intrinsics: CompilerHaxeRuntimeIntrinsicPlan;
  readonly schema: 'flight-haxe-runtime-abi/2';
  readonly tasks: CompilerRuntimeTaskCapabilityPlan;
}

export interface CompilerRustRuntimeRepresentationPlan {
  readonly nullability: Readonly<{ nonNull: 'direct'; nullableTargetName: 'Option' }>;
  readonly ownership: Readonly<{
    nonCopyReuse: 'clone';
    runtimeWrapperCarrier: 'owned';
    temporaryAccess: 'borrow';
  }>;
  readonly schema: 'flight-rust-runtime-representation/1';
}

export type CompilerRustRuntimeRequirement =
  | Readonly<{ kind: 'function'; targetName: string }>
  | Readonly<{ kind: 'member'; memberName: string; targetName: string }>
  | Readonly<{ kind: 'trait'; targetName: string; traitName: string }>
  | Readonly<{ kind: 'type'; targetName: string }>;

export interface CompilerRustRuntimeTaskRequirements {
  readonly adapter: Readonly<{
    cancellation: 'drop-future-on-last-task-owner';
    executor: 'local-eager';
    future: "Future<Output = T> + 'static";
    member: 'from_future';
    ownership: 'consume-once';
    rejection: Readonly<{
      panicFunction: 'flight_runtime::panic_task_rejection';
      stringPanic: 'preserve-string';
      taskRejection: 'preserve-string';
      unknownPanic: 'native future panicked';
    }>;
    sharing: 'shared-settlement';
    unwind: 'required';
  }>;
  readonly awaitBoundary: Readonly<{
    cloneTrait: 'Clone';
    futureTrait: 'Future';
    repeatedAwait: 'clone-before-await';
  }>;
  readonly readyMember: 'ready';
  readonly schema: 'flight-rust-runtime-task-requirements/2';
  readonly settlement: Readonly<{
    rejectionCarrier: 'String';
    result: 'Result<T, String>';
    settleMember: 'settle';
    unhandledRejection: 'structured-panic';
  }>;
  readonly taskType: 'FlightTask';
}

export type CompilerRustRuntimeUnsupportedCapability = Readonly<{
  capability: 'typed-error-carrier' | 'utf16-code-unit-index' | 'utf16-code-unit-range';
  rule:
    | 'rust-runtime-error-carrier-incomplete'
    | 'rust-string-utf16-index-unrepresented'
    | 'rust-string-utf16-range-unrepresented';
  subjects: readonly string[];
}>;

export interface CompilerRustRuntimeRequirementsPlan {
  readonly requirements: readonly CompilerRustRuntimeRequirement[];
  readonly schema: 'flight-rust-runtime-requirements/1';
  readonly tasks: CompilerRustRuntimeTaskRequirements;
  readonly unsupportedCapabilities: readonly CompilerRustRuntimeUnsupportedCapability[];
}

// What the executable module-evaluation plan requires from the runtime: the runtime owns the error
// type the generated lifecycle hooks return, and the one operation that reports a rejected
// re-entrant bootstrap. The error must cross the bootstrap boundary and be recoverable, which is what
// the trait set states; no module execution behavior is described here.
export interface CompilerRustModuleEvaluationRuntimeRequirements {
  readonly error: Readonly<{
    readonly targetName: 'FlightModuleEvaluationError';
    readonly traits: readonly ['Clone', 'Send', 'Sync', "'static"];
  }>;
  readonly reentrancy: Readonly<{
    readonly operation: Readonly<{
      readonly kind: 'function';
      readonly result: 'FlightModuleEvaluationError';
      readonly targetName: 'flight_runtime::module_evaluation_reentrancy_error';
    }>;
    readonly policy: 'reject';
  }>;
  readonly schema: 'flight-rust-runtime-module-evaluation-requirements/1';
}

export interface CompilerRustRuntimeRequirementsPlanV2 {
  readonly moduleEvaluation: CompilerRustModuleEvaluationRuntimeRequirements;
  readonly requirements: readonly CompilerRustRuntimeRequirement[];
  readonly schema: 'flight-rust-runtime-requirements/2';
  readonly tasks: CompilerRustRuntimeTaskRequirements;
  readonly unsupportedCapabilities: readonly CompilerRustRuntimeUnsupportedCapability[];
}

export interface CompilerRustRuntimeAbiManifestV3 {
  readonly ambientMembers: CompilerRustAmbientMemberBindingPlan;
  readonly constructors: CompilerRuntimeExternalConstructorAbiPlan;
  readonly externalSymbols: CompilerRustRuntimeExternalSymbolBindingPlan;
  readonly representation: CompilerRustRuntimeRepresentationPlan;
  readonly requirements: CompilerRustRuntimeRequirementsPlan;
  readonly schema: 'flight-rust-runtime-abi/3';
}

export interface CompilerRustRuntimeAbiManifestV4 {
  readonly ambientMembers: CompilerRustAmbientMemberBindingPlan;
  readonly constructors: CompilerRuntimeExternalConstructorAbiPlan;
  readonly externalSymbols: CompilerRustRuntimeExternalSymbolBindingPlan;
  readonly representation: CompilerRustRuntimeRepresentationPlan;
  readonly requirements: CompilerRustRuntimeRequirementsPlanV2;
  readonly schema: 'flight-rust-runtime-abi/4';
}

export type CompilerRustRuntimeAbiManifest = CompilerRustRuntimeAbiManifestV3 | CompilerRustRuntimeAbiManifestV4;

export type CompilerRuntimeAbiManifest = CompilerHaxeRuntimeAbiManifest | CompilerRustRuntimeAbiManifest;

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

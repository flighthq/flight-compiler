import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerRuntimeAbiManifest, CompilerRuntimeExternalMemberBinding } from './compilerRuntimeContract.js';
import type { CompilerSourceIdentity } from './compilerSourceIdentity.js';

export interface EmittedFileIdentity {
  readonly path: string;
}

export interface EmittedFile extends EmittedFileIdentity {
  readonly contents: string;
  /** Target dependency spellings required to compile this file, such as C++ include paths. */
  readonly dependencies?: readonly string[] | undefined;
}

export interface BackendEmitContext<Options> {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly IrModule[];
  readonly options: Readonly<Options>;
}

export interface CompilerBackend<Options = Record<string, never>> {
  /**
   * Optionally prepares graph-wide analysis once. Orchestration uses this session for every module
   * in the request, while `emitModule` remains the single-module compatibility entry point.
   */
  readonly createEmissionSession?:
    | ((context: BackendEmitContext<Options>) => CompilerBackendEmissionSession)
    | undefined;
  readonly emitModule: (module: Readonly<IrModule>, context: BackendEmitContext<Options>) => readonly EmittedFile[];
  readonly name: string;
  /** Versioned runtime surface required by this backend's emitted code. */
  readonly runtimeAbi?: (() => CompilerRuntimeAbiManifest) | undefined;
}

export interface CompilerBackendEmissionSession {
  readonly emitModule: (module: Readonly<IrModule>) => readonly EmittedFile[];
}

export interface BackendCompilation {
  readonly backend: string;
  readonly files: readonly EmittedFile[];
}

export type BackendEmissionFailureCode = 'unsupported-ir';

export interface BackendEmissionFailure extends Error, CompilerSourceIdentity {
  readonly backend: string;
  readonly code: BackendEmissionFailureCode;
  /**
   * One-based source column, absent when the backend cannot place the construct it refused. A backend
   * emits whole declarations, so the position is the declaration being emitted when the refusal names
   * syntax inside one, and absent when the refusal is about the module rather than a declaration in it.
   */
  readonly column?: number;
  readonly kind: 'backend-emission';
  readonly line?: number;
  /**
   * The stable identity of the decision this refusal records, when the message is not one.
   *
   * A message that names no instance — `object getters require target-specific accessor lowering` —
   * is already the identity of the decision and needs no second spelling. A message that embeds
   * instance data is not: forty modules refused for forty different missing symbols produce forty
   * messages describing one decision, and only the rule tells a consumer that. So `rule` is present
   * exactly when the message varies by instance, and a consumer groups by `rule ?? message`.
   */
  readonly rule?: string | undefined;
}

export type HaxeCompilerEmissionMode = 'extern' | 'transpile';

export interface HaxeCompilerBackendOptions {
  /** Whether Haxe binds JavaScript exports or transpiles their implementations. Defaults to `transpile`. */
  readonly emissionMode?: HaxeCompilerEmissionMode | undefined;
  readonly rootPackage?: string | undefined;
  /**
   * How a data shape is represented. `anonymous` is the honest structural translation of a
   * structural source type. `structInit` names it as a class instead, which the static targets give
   * real field offsets rather than the hashed lookup an anonymous structure resolves to, at the cost
   * of the structural interchange the source language allows.
   */
  readonly structuralRecords?: 'anonymous' | 'structInit' | undefined;
  readonly runtimeModule?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export type CppCompilerRuntimeProfile = 'flight-cpp' | 'standard-library';

export interface CppCompilerExternalBindingConstruction {
  readonly kind: 'constructor' | 'factory';
  readonly targetName: string;
}

export interface CppCompilerExternalBinding {
  readonly callResultType?: string | undefined;
  readonly construction?: CppCompilerExternalBindingConstruction | undefined;
  readonly headers: readonly string[];
  /** Static members for value-space bindings; instance members for type-space bindings. */
  readonly members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
  readonly nullability: 'non-null' | 'nullable';
  readonly ownership: 'borrowed' | 'owned' | 'shared' | 'value';
  readonly sourceName: string;
  readonly space: 'type' | 'value';
  readonly targetName: string;
  readonly weakKeyPolicyTargetName?: string | undefined;
}

export interface CppCompilerExternalBindingManifest {
  readonly bindings: readonly CppCompilerExternalBinding[];
  readonly schema: 'flight-cpp-external-bindings/1';
}

export interface CppCompilerPackageTarget {
  readonly includePrefix: string;
  readonly namespace: string;
}

export interface CppCompilerBackendOptions {
  /** Target-native bindings supplied by the embedding package rather than the compiler runtime. */
  readonly externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined;
  /** Installed include and public namespace identity for each source package. */
  readonly packageTargets?: Readonly<Record<string, Readonly<CppCompilerPackageTarget>>> | undefined;
  /**
   * Runtime representation elected by the backend. `standard-library` preserves the provisional
   * container mapping for generic consumers; `flight-cpp` elects the semantic runtime contract.
   */
  readonly runtimeProfile?: CppCompilerRuntimeProfile | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerBackendOptions {
  /** Target-native host bindings supplied by the embedding Rust workspace. */
  readonly hostBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined;
  readonly opaqueHostType?: string | undefined;
  /** Crate the runtime contract's Rust types are imported from. */
  readonly runtimeCrate?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerExternalBinding {
  readonly members?: readonly Readonly<{ sourceMember: string; targetName: string }>[] | undefined;
  readonly nullability: 'non-null' | 'nullable';
  readonly ownership: 'borrowed' | 'owned' | 'shared' | 'value';
  readonly sourceName: string;
  readonly space: 'type' | 'value';
  readonly targetName: string;
}

export interface RustCompilerExternalBindingManifest {
  readonly bindings: readonly RustCompilerExternalBinding[];
  readonly schema: 'flight-rust-external-bindings/1';
}

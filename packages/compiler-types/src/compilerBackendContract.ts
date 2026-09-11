import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
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
  readonly kind: 'backend-emission';
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
  readonly members?: readonly Readonly<{ sourceMember: string; targetName: string }>[] | undefined;
  readonly nullability: 'non-null' | 'nullable';
  readonly ownership: 'borrowed' | 'owned' | 'shared' | 'value';
  readonly sourceName: string;
  readonly space: 'type' | 'value';
  readonly targetName: string;
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
  readonly opaqueHostType?: string | undefined;
  /** Crate the runtime contract's Rust types are imported from. */
  readonly runtimeCrate?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

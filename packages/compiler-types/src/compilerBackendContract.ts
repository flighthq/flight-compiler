import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerSourceIdentity } from './compilerSourceIdentity.js';

export interface EmittedFileIdentity {
  readonly path: string;
}

export interface EmittedFile extends EmittedFileIdentity {
  readonly contents: string;
}

export interface BackendEmitContext<Options> {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly IrModule[];
  readonly options: Readonly<Options>;
}

export interface CompilerBackend<Options = Record<string, never>> {
  readonly emitModule: (module: Readonly<IrModule>, context: BackendEmitContext<Options>) => readonly EmittedFile[];
  readonly name: string;
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

export interface HaxeCompilerBackendOptions {
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

export interface CppCompilerBackendOptions {
  readonly runtimeHeader?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerBackendOptions {
  readonly opaqueHostType?: string | undefined;
  /** Crate the runtime contract's Rust types are imported from. */
  readonly runtimeCrate?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

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
  readonly runtimeModule?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerBackendOptions {
  readonly opaqueHostType?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

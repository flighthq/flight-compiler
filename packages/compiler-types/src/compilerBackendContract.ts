import type { IrModule } from './compilerIntermediateRepresentation.js';

export interface EmittedFile {
  readonly contents: string;
  readonly path: string;
}

export interface BackendEmitContext<Options> {
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

export interface BackendEmissionFailure extends Error {
  readonly backend: string;
  readonly kind: 'backend-emission';
  readonly source: string;
}

export interface HaxeCompilerBackendOptions {
  readonly generatedHeader?: string | undefined;
  readonly rootPackage?: string | undefined;
  readonly runtimeModule?: string | undefined;
}

export interface RustCompilerBackendOptions {
  readonly generatedHeader?: string | undefined;
  readonly opaqueHostType?: string | undefined;
}

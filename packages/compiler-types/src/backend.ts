import type { IrModule } from './ir.js';

export interface EmittedFile {
  contents: string;
  path: string;
}

export interface BackendEmitContext<Options> {
  modules: readonly IrModule[];
  options: Readonly<Options>;
}

export interface CompilerBackend<Options = Record<string, never>> {
  emitModule(module: Readonly<IrModule>, context: BackendEmitContext<Options>): readonly EmittedFile[];
  name: string;
}

export interface BackendCompilation {
  backend: string;
  files: EmittedFile[];
}

export interface BackendEmissionFailure extends Error {
  backend: string;
  kind: 'backend-emission';
  source: string;
}

export interface HaxeBackendOptions {
  generatedHeader?: string | undefined;
  rootPackage?: string | undefined;
  runtimeModule?: string | undefined;
}

export interface RustBackendOptions {
  generatedHeader?: string | undefined;
  opaqueHostType?: string | undefined;
}

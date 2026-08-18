import type { IrModule } from './ir.ts';

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

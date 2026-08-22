import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type CompilerModuleFacadeLane = 'type' | 'value';

export type CompilerModuleFacadeSource =
  | Readonly<{ bindingId: string; kind: 'local-binding' }>
  | Readonly<{ kind: 'local-expression' }>
  | Readonly<{ kind: 'module-all'; specifier: string }>
  | Readonly<{ imported: string; kind: 'module-binding'; specifier: string }>
  | Readonly<{ kind: 'module-namespace'; specifier: string }>;

export interface CompilerModuleFacadeIdentity {
  readonly exportName: string;
  readonly identity: string;
  readonly lane: CompilerModuleFacadeLane;
  readonly module: CompilerModuleIdentity;
  readonly source: CompilerModuleFacadeSource;
}

export type CompilerModuleFacadeFailureCode =
  | 'duplicate-facade-identity'
  | 'invalid-facade-export'
  | 'invalid-facade-module';

export interface CompilerModuleFacadeFailure extends Error {
  readonly code: CompilerModuleFacadeFailureCode;
  readonly kind: 'compiler-module-facade';
  readonly subject: string;
}

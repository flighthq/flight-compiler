import type { IrDeclaration } from './compilerDeclarationIntermediateRepresentation.js';
import type { IrExpression } from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface IrImportBinding {
  readonly imported: string;
  readonly local: string;
  readonly typeOnly: boolean;
}

export interface IrImport {
  readonly bindings: readonly IrImportBinding[];
  readonly specifier: string;
}

export type IrExport =
  | Readonly<{ kind: 'all'; specifier: string; typeOnly: boolean }>
  | Readonly<{ exported: string; imported: string; kind: 'reexport'; specifier: string; typeOnly: boolean }>
  | Readonly<{ exported: string; kind: 'local'; local: string; typeOnly: boolean }>
  | Readonly<{ exported: string; kind: 'namespace'; specifier: string; typeOnly: boolean }>
  | Readonly<{ expression: IrExpression; kind: 'default' }>;

export interface IrModule extends CompilerModuleIdentity {
  readonly declarations: readonly IrDeclaration[];
  readonly exports: readonly IrExport[];
  readonly imports: readonly IrImport[];
}

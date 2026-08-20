import type { IrBindingIdentity, IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrDeclaration } from './compilerDeclarationIntermediateRepresentation.js';
import type { IrExpression } from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export type IrImportBinding =
  | Readonly<{ binding: IrBindingIdentity; imported: string; typeOnly: false }>
  | Readonly<{ binding: IrTypeBindingIdentity; imported: string; typeOnly: true }>;

export interface IrImport {
  readonly bindings: readonly IrImportBinding[];
  readonly specifier: string;
}

export type IrExport =
  | Readonly<{ kind: 'all'; specifier: string; typeOnly: boolean }>
  | Readonly<{ exported: string; imported: string; kind: 'reexport'; specifier: string; typeOnly: boolean }>
  | Readonly<{ binding: IrBindingIdentity; exported: string; kind: 'local'; typeOnly: boolean }>
  | Readonly<{ binding: IrTypeBindingIdentity; exported: string; kind: 'local'; typeOnly: true }>
  | Readonly<{ exported: string; kind: 'namespace'; specifier: string; typeOnly: boolean }>
  | Readonly<{ expression: IrExpression; kind: 'default' }>;

export interface IrModule extends CompilerModuleIdentity {
  readonly declarations: readonly IrDeclaration[];
  readonly exports: readonly IrExport[];
  readonly imports: readonly IrImport[];
}

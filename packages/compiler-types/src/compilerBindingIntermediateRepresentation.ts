import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';

export type IrBindingKind =
  | 'catch'
  | 'class'
  | 'enum'
  | 'function'
  | 'import'
  | 'interface'
  | 'parameter'
  | 'typeAlias'
  | 'variable';

export type IrBindingScope = 'local' | 'module';

export interface IrBindingIdentity extends CompilerSourceOrigin {
  readonly id: string;
  readonly kind: IrBindingKind;
  readonly name: string;
  readonly scope: IrBindingScope;
}

export type IrIdentifierReference =
  | Readonly<{ binding: IrBindingIdentity; kind: 'binding' }>
  | Readonly<{ kind: 'ambient'; name: string }>
  | Readonly<{ kind: 'this' }>;

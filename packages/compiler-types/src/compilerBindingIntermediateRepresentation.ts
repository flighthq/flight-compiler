import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';

export type IrBindingKind = 'catch' | 'class' | 'enum' | 'function' | 'import' | 'parameter' | 'variable';

export type IrBindingScope = 'local' | 'module';

export interface IrBindingIdentity extends CompilerSourceOrigin {
  readonly id: string;
  readonly kind: IrBindingKind;
  readonly name: string;
  readonly scope: IrBindingScope;
  readonly space: 'value';
}

export type IrTypeBindingKind = 'import' | 'interface' | 'typeAlias' | 'typeParameter';

export interface IrTypeBindingIdentity extends CompilerSourceOrigin {
  readonly id: string;
  readonly kind: IrTypeBindingKind;
  readonly name: string;
  readonly scope: IrBindingScope;
  readonly space: 'type';
}

export type IrTypeNameReference =
  | Readonly<{ binding: IrBindingIdentity | IrTypeBindingIdentity; kind: 'binding'; path: readonly string[] }>
  | Readonly<{ kind: 'ambient'; name: string }>;

export type IrValueNameReference =
  | Readonly<{ binding: IrBindingIdentity; kind: 'binding'; path: readonly string[] }>
  | Readonly<{ kind: 'ambient'; name: string }>;

export type IrIdentifierReference =
  | Readonly<{ binding: IrBindingIdentity; kind: 'binding' }>
  | Readonly<{ kind: 'ambient'; name: string }>
  | Readonly<{ kind: 'this' }>;

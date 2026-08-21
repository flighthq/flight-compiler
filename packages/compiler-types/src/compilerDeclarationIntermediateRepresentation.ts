import type { IrBindingIdentity, IrTypeBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type {
  IrExpression,
  IrParameter,
  IrStatement,
  IrVariable,
} from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';
import type {
  IrObjectTypeProperty,
  IrType,
  IrTypeParameter,
  IrTypeReference,
} from './compilerTypeIntermediateRepresentation.js';

export interface IrFunctionSignature {
  readonly parameters: readonly IrParameter[];
  readonly returns: IrType;
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrFunctionDeclaration extends IrFunctionSignature {
  readonly async: boolean;
  readonly body: readonly IrStatement[];
  readonly binding: IrBindingIdentity;
  readonly exported: boolean;
  readonly kind: 'function';
  readonly origin: CompilerSourceOrigin;
  readonly overloads: readonly IrFunctionSignature[];
}

export type IrVariableDeclaration = IrVariable &
  Readonly<{
    readonly exported: boolean;
    readonly kind: 'variable';
    readonly origin: CompilerSourceOrigin;
  }>;

export interface IrTypeAliasDeclaration {
  readonly binding: IrTypeBindingIdentity;
  readonly exported: boolean;
  readonly kind: 'typeAlias';
  readonly origin: CompilerSourceOrigin;
  readonly type: IrType;
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrInterfaceDeclaration {
  readonly binding: IrTypeBindingIdentity;
  readonly exported: boolean;
  readonly extends: readonly IrTypeReference[];
  readonly kind: 'interface';
  readonly origin: CompilerSourceOrigin;
  readonly properties: readonly IrObjectTypeProperty[];
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrEnumMember {
  readonly name: string;
  readonly value: number | string;
}

export interface IrEnumDeclaration {
  readonly binding: IrBindingIdentity;
  readonly exported: boolean;
  readonly kind: 'enum';
  readonly members: readonly IrEnumMember[];
  readonly origin: CompilerSourceOrigin;
}

export type IrClassMemberVisibility = 'private' | 'protected' | 'public';

export interface IrClassConstructor {
  readonly body: readonly IrStatement[];
  readonly parameters: readonly IrParameter[];
}

export interface IrClassField {
  readonly initializer?: IrExpression | undefined;
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly static: boolean;
  readonly type: IrType;
  readonly visibility: IrClassMemberVisibility;
}

export interface IrClassMethod extends IrFunctionSignature {
  readonly async: boolean;
  readonly body: readonly IrStatement[];
  readonly name: string;
  readonly static: boolean;
  readonly visibility: IrClassMemberVisibility;
}

export interface IrClassDeclaration {
  readonly abstract: boolean;
  readonly binding: IrBindingIdentity;
  readonly classConstructor?: IrClassConstructor | undefined;
  readonly exported: boolean;
  readonly extends?: IrTypeReference | undefined;
  readonly fields: readonly IrClassField[];
  readonly implements: readonly IrTypeReference[];
  readonly kind: 'class';
  readonly methods: readonly IrClassMethod[];
  readonly origin: CompilerSourceOrigin;
  readonly typeParameters: readonly IrTypeParameter[];
}

export type IrDeclaration =
  | IrClassDeclaration
  | IrEnumDeclaration
  | IrFunctionDeclaration
  | IrInterfaceDeclaration
  | IrTypeAliasDeclaration
  | IrVariableDeclaration;

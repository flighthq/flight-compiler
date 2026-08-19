import type { CompilerModuleIdentity, CompilerSourceOrigin } from './compilerSourceIdentity.js';

export interface IrTypeParameter {
  readonly constraint?: IrType | undefined;
  readonly default?: IrType | undefined;
  readonly name: string;
}

export interface IrParameter {
  readonly initializer?: IrExpression | undefined;
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly type: IrType;
}

export interface IrObjectTypeMember {
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: IrType;
}

export type IrType =
  | Readonly<{ kind: 'array'; element: IrType; readonly: boolean }>
  | Readonly<{
      kind: 'function';
      parameters: readonly IrParameter[];
      returns: IrType;
      typeParameters: readonly IrTypeParameter[];
    }>
  | Readonly<{ kind: 'indexedAccess'; index: IrType; object: IrType }>
  | Readonly<{ kind: 'intersection'; types: readonly IrType[] }>
  | Readonly<{ kind: 'keyof'; type: IrType }>
  | Readonly<{ kind: 'literal'; value: boolean | number | string }>
  | Readonly<{ kind: 'named'; name: string; typeArguments: readonly IrType[] }>
  | Readonly<{ kind: 'never' }>
  | Readonly<{ kind: 'null' }>
  | Readonly<{ kind: 'object'; members: readonly IrObjectTypeMember[] }>
  | Readonly<{ kind: 'primitive'; name: 'bigint' | 'boolean' | 'number' | 'string' | 'symbol' | 'void' }>
  | Readonly<{
      kind: 'tuple';
      elements: ReadonlyArray<Readonly<{ optional: boolean; rest: boolean; type: IrType }>>;
      readonly: boolean;
    }>
  | Readonly<{ kind: 'typeOf'; name: string }>
  | Readonly<{ kind: 'undefined' }>
  | Readonly<{ kind: 'union'; types: readonly IrType[] }>
  | Readonly<{ kind: 'unknown'; source: 'any' | 'object' | 'this' | 'unknown' }>;

export type IrExpression =
  | Readonly<{ kind: 'array'; elements: ReadonlyArray<IrExpression | undefined> }>
  | Readonly<{ kind: 'assignment'; left: IrExpression; operator: string; right: IrExpression }>
  | Readonly<{ kind: 'await'; expression: IrExpression }>
  | Readonly<{ kind: 'binary'; left: IrExpression; operator: string; right: IrExpression }>
  | Readonly<{
      kind: 'call';
      arguments: readonly IrExpression[];
      callee: IrExpression;
      optional: boolean;
      typeArguments: readonly IrType[];
    }>
  | Readonly<{ kind: 'cast'; expression: IrExpression; type: IrType }>
  | Readonly<{ condition: IrExpression; kind: 'conditional'; whenFalse: IrExpression; whenTrue: IrExpression }>
  | Readonly<{ index: IrExpression; kind: 'element'; object: IrExpression; optional: boolean }>
  | Readonly<{
      async: boolean;
      body: readonly IrStatement[];
      expression?: IrExpression | undefined;
      kind: 'function';
      name?: string | undefined;
      parameters: readonly IrParameter[];
      returns: IrType;
      typeParameters: readonly IrTypeParameter[];
    }>
  | Readonly<{ kind: 'identifier'; name: string }>
  | Readonly<{ kind: 'literal'; value: boolean | null | number | string }>
  | Readonly<{
      arguments: readonly IrExpression[];
      callee: IrExpression;
      kind: 'new';
      typeArguments: readonly IrType[];
    }>
  | Readonly<{ kind: 'object'; members: readonly IrObjectMember[] }>
  | Readonly<{ kind: 'property'; name: string; object: IrExpression; optional: boolean }>
  | Readonly<{ flags: string; kind: 'regexp'; pattern: string }>
  | Readonly<{ expression: IrExpression; kind: 'spread' }>
  | Readonly<{ kind: 'template'; parts: ReadonlyArray<IrExpression | string> }>
  | Readonly<{ kind: 'unary'; operand: IrExpression; operator: string; postfix: boolean }>;

export type IrObjectMember =
  | Readonly<{ key: IrExpression; kind: 'computedProperty'; value: IrExpression }>
  | Readonly<{ kind: 'property'; name: string; value: IrExpression }>
  | Readonly<{ expression: IrExpression; kind: 'spread' }>;

export interface IrVariable {
  readonly initializer?: IrExpression | undefined;
  readonly mutable: boolean;
  readonly name: string;
  readonly type?: IrType | undefined;
}

export interface IrSwitchCase {
  readonly expression?: IrExpression | undefined;
  readonly statements: readonly IrStatement[];
}

export type IrStatement =
  | Readonly<{ kind: 'block'; statements: readonly IrStatement[] }>
  | Readonly<{ kind: 'break' }>
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ body: IrStatement; condition: IrExpression; kind: 'do' }>
  | Readonly<{ expression: IrExpression; kind: 'expression' }>
  | Readonly<{
      body: IrStatement;
      condition?: IrExpression | undefined;
      increment?: IrExpression | undefined;
      initializer?: IrExpression | readonly IrVariable[] | undefined;
      kind: 'for';
    }>
  | Readonly<{ await: boolean; body: IrStatement; iterable: IrExpression; kind: 'forOf'; variable: IrVariable }>
  | Readonly<{ body: IrStatement; kind: 'forIn'; object: IrExpression; variable: IrVariable }>
  | Readonly<{
      condition: IrExpression;
      consequent: IrStatement;
      kind: 'if';
      otherwise?: IrStatement | undefined;
    }>
  | Readonly<{ expression?: IrExpression | undefined; kind: 'return' }>
  | Readonly<{ cases: readonly IrSwitchCase[]; expression: IrExpression; kind: 'switch' }>
  | Readonly<{ expression: IrExpression; kind: 'throw' }>
  | Readonly<{
      catchBody?: IrStatement | undefined;
      catchName?: string | undefined;
      finallyBody?: IrStatement | undefined;
      kind: 'try';
      tryBody: IrStatement;
    }>
  | Readonly<{ declarations: readonly IrVariable[]; kind: 'variable' }>
  | Readonly<{ body: IrStatement; condition: IrExpression; kind: 'while' }>;

export interface IrFunctionSignature {
  readonly parameters: readonly IrParameter[];
  readonly returns: IrType;
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrFunctionDeclaration extends IrFunctionSignature {
  readonly async: boolean;
  readonly body: readonly IrStatement[];
  readonly exported: boolean;
  readonly kind: 'function';
  readonly name: string;
  readonly origin: CompilerSourceOrigin;
  readonly overloads: readonly IrFunctionSignature[];
}

export interface IrVariableDeclaration extends IrVariable {
  readonly exported: boolean;
  readonly kind: 'variable';
  readonly origin: CompilerSourceOrigin;
}

export interface IrTypeDeclaration {
  readonly exported: boolean;
  readonly kind: 'type';
  readonly name: string;
  readonly origin: CompilerSourceOrigin;
  readonly type: IrType;
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrInterfaceDeclaration {
  readonly exported: boolean;
  readonly extends: readonly IrType[];
  readonly kind: 'interface';
  readonly members: readonly IrObjectTypeMember[];
  readonly name: string;
  readonly origin: CompilerSourceOrigin;
  readonly typeParameters: readonly IrTypeParameter[];
}

export interface IrEnumDeclaration {
  readonly exported: boolean;
  readonly kind: 'enum';
  readonly members: ReadonlyArray<{ readonly name: string; readonly value: number | string }>;
  readonly name: string;
  readonly origin: CompilerSourceOrigin;
}

export interface IrClassField {
  readonly initializer?: IrExpression | undefined;
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly static: boolean;
  readonly type: IrType;
  readonly visibility: 'private' | 'protected' | 'public';
}

export interface IrClassMethod extends IrFunctionSignature {
  readonly async: boolean;
  readonly body: readonly IrStatement[];
  readonly name: string;
  readonly static: boolean;
  readonly visibility: 'private' | 'protected' | 'public';
}

export interface IrClassDeclaration {
  readonly abstract: boolean;
  readonly constructorBody: readonly IrStatement[];
  readonly constructorParameters: readonly IrParameter[];
  readonly exported: boolean;
  readonly extends?: IrType | undefined;
  readonly fields: readonly IrClassField[];
  readonly implements: readonly IrType[];
  readonly kind: 'class';
  readonly methods: readonly IrClassMethod[];
  readonly name: string;
  readonly origin: CompilerSourceOrigin;
  readonly typeParameters: readonly IrTypeParameter[];
}

export type IrDeclaration =
  | IrClassDeclaration
  | IrEnumDeclaration
  | IrFunctionDeclaration
  | IrInterfaceDeclaration
  | IrTypeDeclaration
  | IrVariableDeclaration;

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

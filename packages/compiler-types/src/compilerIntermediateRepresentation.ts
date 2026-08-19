export interface SourceOrigin {
  column: number;
  fingerprint: string;
  line: number;
  packageName: string;
  source: string;
}

export interface IrTypeParameter {
  constraint?: IrType | undefined;
  default?: IrType | undefined;
  name: string;
}

export interface IrParameter {
  initializer?: IrExpression | undefined;
  name: string;
  optional: boolean;
  rest: boolean;
  type: IrType;
}

export interface IrObjectTypeMember {
  name: string;
  optional: boolean;
  readonly: boolean;
  type: IrType;
}

export type IrType =
  | { kind: 'array'; element: IrType; readonly: boolean }
  | { kind: 'function'; parameters: IrParameter[]; returns: IrType; typeParameters: IrTypeParameter[] }
  | { kind: 'indexedAccess'; index: IrType; object: IrType }
  | { kind: 'intersection'; types: IrType[] }
  | { kind: 'keyof'; type: IrType }
  | { kind: 'literal'; value: boolean | number | string }
  | { kind: 'named'; name: string; typeArguments: IrType[] }
  | { kind: 'never' }
  | { kind: 'null' }
  | { kind: 'object'; members: IrObjectTypeMember[] }
  | { kind: 'primitive'; name: 'bigint' | 'boolean' | 'number' | 'string' | 'symbol' | 'void' }
  | { kind: 'tuple'; elements: Array<{ optional: boolean; rest: boolean; type: IrType }>; readonly: boolean }
  | { kind: 'typeOf'; name: string }
  | { kind: 'undefined' }
  | { kind: 'union'; types: IrType[] }
  | { kind: 'unknown'; source: 'any' | 'object' | 'this' | 'unknown' };

export type IrExpression =
  | { kind: 'array'; elements: Array<IrExpression | undefined> }
  | { kind: 'assignment'; left: IrExpression; operator: string; right: IrExpression }
  | { kind: 'await'; expression: IrExpression }
  | { kind: 'binary'; left: IrExpression; operator: string; right: IrExpression }
  | { kind: 'call'; arguments: IrExpression[]; callee: IrExpression; optional: boolean; typeArguments: IrType[] }
  | { kind: 'cast'; expression: IrExpression; type: IrType }
  | { condition: IrExpression; kind: 'conditional'; whenFalse: IrExpression; whenTrue: IrExpression }
  | { index: IrExpression; kind: 'element'; object: IrExpression; optional: boolean }
  | {
      async: boolean;
      body: IrStatement[];
      expression?: IrExpression | undefined;
      kind: 'function';
      name?: string | undefined;
      parameters: IrParameter[];
      returns: IrType;
      typeParameters: IrTypeParameter[];
    }
  | { kind: 'identifier'; name: string }
  | { kind: 'literal'; value: boolean | null | number | string }
  | { arguments: IrExpression[]; callee: IrExpression; kind: 'new'; typeArguments: IrType[] }
  | { kind: 'object'; members: IrObjectMember[] }
  | { kind: 'property'; name: string; object: IrExpression; optional: boolean }
  | { flags: string; kind: 'regexp'; pattern: string }
  | { expression: IrExpression; kind: 'spread' }
  | { kind: 'template'; parts: Array<IrExpression | string> }
  | { kind: 'unary'; operand: IrExpression; operator: string; postfix: boolean };

export type IrObjectMember =
  | { key: IrExpression; kind: 'computedProperty'; value: IrExpression }
  | { kind: 'property'; name: string; value: IrExpression }
  | { expression: IrExpression; kind: 'spread' };

export interface IrVariable {
  initializer?: IrExpression | undefined;
  mutable: boolean;
  name: string;
  type?: IrType | undefined;
}

export interface IrSwitchCase {
  expression?: IrExpression | undefined;
  statements: IrStatement[];
}

export type IrStatement =
  | { kind: 'block'; statements: IrStatement[] }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { body: IrStatement; condition: IrExpression; kind: 'do' }
  | { expression: IrExpression; kind: 'expression' }
  | {
      body: IrStatement;
      condition?: IrExpression | undefined;
      increment?: IrExpression | undefined;
      initializer?: IrExpression | IrVariable[] | undefined;
      kind: 'for';
    }
  | { await: boolean; body: IrStatement; iterable: IrExpression; kind: 'forOf'; variable: IrVariable }
  | { body: IrStatement; kind: 'forIn'; object: IrExpression; variable: IrVariable }
  | { condition: IrExpression; consequent: IrStatement; kind: 'if'; otherwise?: IrStatement | undefined }
  | { expression?: IrExpression | undefined; kind: 'return' }
  | { cases: IrSwitchCase[]; expression: IrExpression; kind: 'switch' }
  | { expression: IrExpression; kind: 'throw' }
  | {
      catchBody?: IrStatement | undefined;
      catchName?: string | undefined;
      finallyBody?: IrStatement | undefined;
      kind: 'try';
      tryBody: IrStatement;
    }
  | { declarations: IrVariable[]; kind: 'variable' }
  | { body: IrStatement; condition: IrExpression; kind: 'while' };

export interface IrFunctionSignature {
  parameters: IrParameter[];
  returns: IrType;
  typeParameters: IrTypeParameter[];
}

export interface IrFunctionDeclaration extends IrFunctionSignature {
  async: boolean;
  body: IrStatement[];
  exported: boolean;
  kind: 'function';
  name: string;
  origin: SourceOrigin;
  overloads: IrFunctionSignature[];
}

export interface IrVariableDeclaration extends IrVariable {
  exported: boolean;
  kind: 'variable';
  origin: SourceOrigin;
}

export interface IrTypeDeclaration {
  exported: boolean;
  kind: 'type';
  name: string;
  origin: SourceOrigin;
  type: IrType;
  typeParameters: IrTypeParameter[];
}

export interface IrInterfaceDeclaration {
  exported: boolean;
  extends: IrType[];
  kind: 'interface';
  members: IrObjectTypeMember[];
  name: string;
  origin: SourceOrigin;
  typeParameters: IrTypeParameter[];
}

export interface IrEnumDeclaration {
  exported: boolean;
  kind: 'enum';
  members: Array<{ name: string; value: number | string }>;
  name: string;
  origin: SourceOrigin;
}

export interface IrClassField {
  initializer?: IrExpression | undefined;
  name: string;
  optional: boolean;
  readonly: boolean;
  static: boolean;
  type: IrType;
  visibility: 'private' | 'protected' | 'public';
}

export interface IrClassMethod extends IrFunctionSignature {
  async: boolean;
  body: IrStatement[];
  name: string;
  static: boolean;
  visibility: 'private' | 'protected' | 'public';
}

export interface IrClassDeclaration {
  abstract: boolean;
  constructorBody: IrStatement[];
  constructorParameters: IrParameter[];
  exported: boolean;
  extends?: IrType | undefined;
  fields: IrClassField[];
  implements: IrType[];
  kind: 'class';
  methods: IrClassMethod[];
  name: string;
  origin: SourceOrigin;
  typeParameters: IrTypeParameter[];
}

export type IrDeclaration =
  | IrClassDeclaration
  | IrEnumDeclaration
  | IrFunctionDeclaration
  | IrInterfaceDeclaration
  | IrTypeDeclaration
  | IrVariableDeclaration;

export interface IrImportBinding {
  imported: string;
  local: string;
  typeOnly: boolean;
}

export interface IrImport {
  bindings: IrImportBinding[];
  specifier: string;
}

export type IrExport =
  | { kind: 'all'; specifier: string; typeOnly: boolean }
  | { exported: string; imported: string; kind: 'reexport'; specifier: string; typeOnly: boolean }
  | { exported: string; kind: 'local'; local: string; typeOnly: boolean }
  | { exported: string; kind: 'namespace'; specifier: string; typeOnly: boolean }
  | { expression: IrExpression; kind: 'default' };

export interface IrModule {
  declarations: IrDeclaration[];
  exports: IrExport[];
  imports: IrImport[];
  name: string;
  packageName: string;
  source: string;
}

export interface CompilerDiagnostic {
  code: string;
  column: number;
  line: number;
  message: string;
  source: string;
}

export interface LoweringResult {
  diagnostics: CompilerDiagnostic[];
  module: IrModule;
}

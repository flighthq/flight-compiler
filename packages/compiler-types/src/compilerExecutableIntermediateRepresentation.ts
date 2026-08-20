import type { IrFunctionTypeParameter, IrType, IrTypeParameter } from './compilerTypeIntermediateRepresentation.js';

export type IrParameter = IrFunctionTypeParameter &
  (Readonly<{ initializer?: never; optional: false }> | Readonly<{ initializer?: IrExpression; optional: true }>);

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

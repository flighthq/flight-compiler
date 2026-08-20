import type {
  IrTypeBindingIdentity,
  IrTypeNameReference,
  IrValueNameReference,
} from './compilerBindingIntermediateRepresentation.js';

export type IrFunctionTypeParameter = Readonly<
  { name: string; type: IrType } & (
    | { optional: false; rest: false }
    | { optional: false; rest: true }
    | { optional: true; rest: false }
  )
>;

export interface IrObjectTypeProperty {
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: IrType;
}

export type IrTupleTypeElement = Readonly<
  { type: IrType } & (
    | { optional: false; rest: false }
    | { optional: false; rest: true }
    | { optional: true; rest: false }
  )
>;

export interface IrTypeParameter {
  readonly binding: IrTypeBindingIdentity;
  readonly constraint?: IrType | undefined;
  readonly default?: IrType | undefined;
}

export interface IrTypeReference {
  readonly kind: 'named';
  readonly reference: IrTypeNameReference;
  readonly typeArguments: readonly IrType[];
}

export type IrType =
  | Readonly<{ kind: 'array'; element: IrType; readonly: boolean }>
  | Readonly<{
      kind: 'function';
      parameters: readonly IrFunctionTypeParameter[];
      returns: IrType;
      typeParameters: readonly IrTypeParameter[];
    }>
  | Readonly<{ kind: 'indexedAccess'; index: IrType; object: IrType }>
  | Readonly<{ kind: 'intersection'; types: readonly [IrType, IrType, ...IrType[]] }>
  | Readonly<{ kind: 'keyof'; type: IrType }>
  | Readonly<{ kind: 'literal'; value: boolean | number | string }>
  | IrTypeReference
  | Readonly<{ kind: 'never' }>
  | Readonly<{ kind: 'null' }>
  | Readonly<{ kind: 'object'; properties: readonly IrObjectTypeProperty[] }>
  | Readonly<{ kind: 'primitive'; name: 'bigint' | 'boolean' | 'number' | 'string' | 'symbol' | 'void' }>
  | Readonly<{ kind: 'tuple'; elements: readonly IrTupleTypeElement[]; readonly: boolean }>
  | Readonly<{ kind: 'typeOf'; reference: IrValueNameReference }>
  | Readonly<{ kind: 'undefined' }>
  | Readonly<{ kind: 'union'; types: readonly [IrType, IrType, ...IrType[]] }>
  | Readonly<{ kind: 'unknown'; source: 'any' | 'object' | 'this' | 'unknown' }>;

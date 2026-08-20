export type IrOperatorValueDomain =
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined'
  | 'unknown';

export interface IrAssignmentOperatorSemantics {
  readonly left: IrOperatorValueDomain;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorValueDomain;
}

export interface IrBinaryOperatorSemantics {
  readonly left: IrOperatorValueDomain;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorValueDomain;
}

export interface IrUnaryOperatorSemantics {
  readonly operand: IrOperatorValueDomain;
  readonly result: IrOperatorValueDomain;
}

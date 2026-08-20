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

export interface IrOperatorOperandDomains {
  readonly declared: IrOperatorValueDomain;
  readonly flow: IrOperatorValueDomain;
}

export interface IrAssignmentOperatorSemantics {
  readonly left: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorOperandDomains;
}

export interface IrBinaryOperatorSemantics {
  readonly left: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorOperandDomains;
}

export interface IrUnaryOperatorSemantics {
  readonly operand: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
}

import type {
  IrAssignmentOperatorSemantics,
  IrBinaryOperatorSemantics,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrUnaryOperatorSemantics,
} from './compilerOperatorSemanticIntermediateRepresentation.js';

describe('compiler operator semantic intermediate representation contracts', () => {
  it('uses one closed target-neutral value-domain vocabulary for every operator arity', () => {
    expectTypeOf<IrOperatorValueDomain>().toEqualTypeOf<
      'bigint' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'symbol' | 'undefined' | 'unknown'
    >();
    expectTypeOf<IrOperatorOperandDomains>().toEqualTypeOf<
      Readonly<{
        declared: IrOperatorValueDomain;
        flow: IrOperatorValueDomain;
      }>
    >();
    expectTypeOf<IrAssignmentOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        left: IrOperatorOperandDomains;
        result: IrOperatorValueDomain;
        right: IrOperatorOperandDomains;
      }>
    >();
    expectTypeOf<IrBinaryOperatorSemantics>().toEqualTypeOf<IrAssignmentOperatorSemantics>();
    expectTypeOf<IrUnaryOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        operand: IrOperatorOperandDomains;
        result: IrOperatorValueDomain;
      }>
    >();
  });
});

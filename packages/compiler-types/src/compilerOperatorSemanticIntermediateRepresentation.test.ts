import type {
  IrAssignmentOperatorSemantics,
  IrBinaryOperatorSemantics,
  IrOperatorValueDomain,
  IrUnaryOperatorSemantics,
} from './compilerOperatorSemanticIntermediateRepresentation.js';

describe('compiler operator semantic intermediate representation contracts', () => {
  it('uses one closed target-neutral value-domain vocabulary for every operator arity', () => {
    expectTypeOf<IrOperatorValueDomain>().toEqualTypeOf<
      'bigint' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'symbol' | 'undefined' | 'unknown'
    >();
    expectTypeOf<IrAssignmentOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        left: IrOperatorValueDomain;
        result: IrOperatorValueDomain;
        right: IrOperatorValueDomain;
      }>
    >();
    expectTypeOf<IrBinaryOperatorSemantics>().toEqualTypeOf<IrAssignmentOperatorSemantics>();
    expectTypeOf<IrUnaryOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        operand: IrOperatorValueDomain;
        result: IrOperatorValueDomain;
      }>
    >();
  });
});

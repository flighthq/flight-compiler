import type {
  IrAssignmentOperator,
  IrBinaryOperator,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
} from './compilerOperatorIntermediateRepresentation.js';

describe('compiler operator intermediate representation contracts', () => {
  it('closes assignment, binary, prefix, and postfix vocabularies', () => {
    expectTypeOf<IrAssignmentOperator>().toEqualTypeOf<
      | '%='
      | '&&='
      | '&='
      | '**='
      | '*='
      | '+='
      | '-='
      | '/='
      | '<<='
      | '='
      | '>>='
      | '>>>='
      | '??='
      | '^='
      | '|='
      | '||='
    >();
    expectTypeOf<IrBinaryOperator>().toEqualTypeOf<
      | '%'
      | '&'
      | '&&'
      | '*'
      | '**'
      | '+'
      | ','
      | '-'
      | '/'
      | '<'
      | '<<'
      | '<='
      | '!='
      | '!=='
      | '=='
      | '==='
      | '>'
      | '>='
      | '>>'
      | '>>>'
      | '??'
      | '^'
      | 'in'
      | 'instanceof'
      | '|'
      | '||'
    >();
    expectTypeOf<IrPrefixUnaryOperator>().toEqualTypeOf<
      '!' | '+' | '++' | '-' | '--' | 'delete' | 'typeof' | 'void' | '~'
    >();
    expectTypeOf<IrPostfixUnaryOperator>().toEqualTypeOf<'++' | '--'>();
  });
});

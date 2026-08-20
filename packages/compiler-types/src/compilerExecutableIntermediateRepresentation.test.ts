import type { IrExpression, IrParameter, IrStatement } from './compilerExecutableIntermediateRepresentation.js';
import type { IrFunctionTypeParameter } from './compilerTypeIntermediateRepresentation.js';

describe('compiler executable intermediate representation contracts', () => {
  it('adds executable initializer data without weakening the type-only parameter contract', () => {
    const expression: IrExpression = { kind: 'literal', value: 1 };
    const parameter: IrParameter = {
      initializer: expression,
      name: 'value',
      optional: true,
      rest: false,
      type: { kind: 'primitive', name: 'number' },
    };
    const statement: IrStatement = { expression, kind: 'return' };

    expect(parameter.initializer).toBe(expression);
    expect(statement.expression).toBe(expression);
    expectTypeOf(parameter).toMatchTypeOf<IrFunctionTypeParameter>();
    expectTypeOf<Extract<IrParameter, { rest: true }>['initializer']>().toEqualTypeOf<undefined>();
  });

  it('couples postfix unary position to valid operators', () => {
    expectTypeOf<Extract<IrExpression, { kind: 'unary'; postfix: true }>['operator']>().toEqualTypeOf<'++' | '--'>();
  });
});

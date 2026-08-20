import type {
  IrFunctionTypeParameter,
  IrTupleTypeElement,
  IrType,
  IrTypeReference,
} from './compilerTypeIntermediateRepresentation.js';

describe('compiler type intermediate representation contracts', () => {
  it('separates structural type parameters and requires compound type arity', () => {
    const reference: IrTypeReference = {
      kind: 'named',
      reference: { kind: 'ambient', name: 'Value' },
      typeArguments: [],
    };
    const parameter: IrFunctionTypeParameter = {
      name: 'value',
      optional: false,
      rest: false,
      type: reference,
    };
    const tupleElement: IrTupleTypeElement = { optional: false, rest: false, type: reference };
    const union: IrType = { kind: 'union', types: [reference, { kind: 'null' }] };

    expect(union.types).toEqual([reference, { kind: 'null' }]);
    expect(tupleElement.type).toBe(reference);
    expectTypeOf<
      Extract<IrType, { kind: 'function' }>['parameters'][number]
    >().toEqualTypeOf<IrFunctionTypeParameter>();
    expectTypeOf<Extract<IrType, { kind: 'union' }>['types']>().toEqualTypeOf<readonly [IrType, IrType, ...IrType[]]>();
    expectTypeOf<Extract<IrFunctionTypeParameter, { rest: true }>['optional']>().toEqualTypeOf<false>();
    expectTypeOf<Extract<IrTupleTypeElement, { optional: true }>['rest']>().toEqualTypeOf<false>();
    expectTypeOf(parameter).not.toHaveProperty('initializer');
  });
});

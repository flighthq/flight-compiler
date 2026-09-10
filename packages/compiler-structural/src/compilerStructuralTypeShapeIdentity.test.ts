import type {
  IrBindingIdentity,
  IrObjectTypeProperty,
  IrType,
  IrTypeBindingIdentity,
} from '../../compiler-types/src/index.js';
import {
  createIrObjectTypeShapeIdentity,
  isCompilerStructuralTypeShapeFailure,
} from './compilerStructuralTypeShapeIdentity.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

describe('createIrObjectTypeShapeIdentity', () => {
  it('is independent of property and compound-member order while preserving semantic modifiers', () => {
    const first = [
      property('value', { kind: 'union', types: [numberType, stringType] }),
      property('label', stringType, true),
    ];
    const reordered = [
      property('label', stringType, true),
      property('value', { kind: 'union', types: [stringType, numberType, numberType] }),
    ];

    expect(createIrObjectTypeShapeIdentity(first)).toBe(createIrObjectTypeShapeIdentity(reordered));
    expect(createIrObjectTypeShapeIdentity(first)).not.toBe(
      createIrObjectTypeShapeIdentity([property('value', numberType), property('label', stringType)]),
    );
    expect(createIrObjectTypeShapeIdentity([property('value', numberType)])).not.toBe(
      createIrObjectTypeShapeIdentity([property('value', numberType, false, true)]),
    );
  });

  it('canonically composes nested type families and keeps value-level distinctions exact', () => {
    const binding = typeParameter('type-parameter:first', 'First');
    const value = valueBinding('binding:host', 'host');
    const type: IrType = {
      kind: 'function',
      parameters: [
        {
          name: 'value',
          optional: false,
          rest: false,
          type: {
            elements: [
              { optional: false, rest: false, type: { element: numberType, kind: 'array', readonly: true } },
              { optional: true, rest: false, type: { kind: 'literal', value: -0 } },
            ],
            kind: 'tuple',
            readonly: false,
          },
        },
      ],
      returns: {
        kind: 'intersection',
        types: [
          {
            index: { kind: 'literal', value: 'key' },
            kind: 'indexedAccess',
            object: { kind: 'unknown', source: 'object' },
          },
          { kind: 'keyof', type: { kind: 'typeOf', reference: { kind: 'ambient', name: 'Host' } } },
        ],
      },
      typeParameters: [
        {
          binding,
          constraint: { kind: 'named', reference: { kind: 'ambient', name: 'Constraint' }, typeArguments: [] },
          default: { kind: 'null' },
        },
      ],
    };
    const renamedBinding = typeParameter('type-parameter:second', 'Second');

    expect(
      createIrObjectTypeShapeIdentity([
        property('callback', type),
        property('typeParameter', {
          kind: 'named',
          reference: { binding, kind: 'binding', path: [] },
          typeArguments: [{ kind: 'never' }, { kind: 'undefined' }],
        }),
        property('typeOfBinding', { kind: 'typeOf', reference: { binding: value, kind: 'binding', path: ['value'] } }),
      ]),
    ).not.toBe(
      createIrObjectTypeShapeIdentity([
        property('callback', type),
        property('typeParameter', {
          kind: 'named',
          reference: { binding: renamedBinding, kind: 'binding', path: [] },
          typeArguments: [{ kind: 'never' }, { kind: 'undefined' }],
        }),
        property('typeOfBinding', { kind: 'typeOf', reference: { binding: value, kind: 'binding', path: ['value'] } }),
      ]),
    );
    expect(createIrObjectTypeShapeIdentity([property('zero', { kind: 'literal', value: -0 })])).not.toBe(
      createIrObjectTypeShapeIdentity([property('zero', { kind: 'literal', value: 0 })]),
    );
    expect(createIrObjectTypeShapeIdentity([property('name', { kind: 'literal', value: 'e\u0301' })])).not.toBe(
      createIrObjectTypeShapeIdentity([property('name', { kind: 'literal', value: '\u00e9' })]),
    );
  });

  it('treats function type parameters as alpha-equivalent identities', () => {
    const first = genericFunctionType(typeParameter('type-parameter:first', 'First'));
    const second = genericFunctionType(typeParameter('type-parameter:second', 'Second'));

    expect(createIrObjectTypeShapeIdentity([property('callback', first)])).toBe(
      createIrObjectTypeShapeIdentity([property('callback', second)]),
    );
  });

  it('distinguishes nested function type parameter positions across offset boundaries', () => {
    const outerParam = typeParameter('type-parameter:outer', 'T');
    const innerParamA = typeParameter('type-parameter:inner-a', 'U');
    const innerParamB = typeParameter('type-parameter:inner-b', 'V');
    const refOuter = {
      kind: 'named',
      reference: { binding: outerParam, kind: 'binding', path: [] },
      typeArguments: [],
    } as const;
    const refB = {
      kind: 'named',
      reference: { binding: innerParamB, kind: 'binding', path: [] },
      typeArguments: [],
    } as const;
    const returnsInnerV: IrType = {
      kind: 'function',
      parameters: [],
      returns: refB,
      typeParameters: [{ binding: innerParamA }, { binding: innerParamB }],
    };
    const returnsOuterT: IrType = {
      kind: 'function',
      parameters: [],
      returns: refOuter,
      typeParameters: [{ binding: innerParamA }, { binding: innerParamB }],
    };
    const fnReturnsV: IrType = {
      kind: 'function',
      parameters: [{ name: 'cb', optional: false, rest: false, type: returnsInnerV }],
      returns: refOuter,
      typeParameters: [{ binding: outerParam }],
    };
    const fnReturnsT: IrType = {
      kind: 'function',
      parameters: [{ name: 'cb', optional: false, rest: false, type: returnsOuterT }],
      returns: refOuter,
      typeParameters: [{ binding: outerParam }],
    };
    expect(createIrObjectTypeShapeIdentity([property('fn', fnReturnsV)])).not.toBe(
      createIrObjectTypeShapeIdentity([property('fn', fnReturnsT)]),
    );
  });

  it('collapses duplicate compound members to their canonical member identity', () => {
    expect(
      createIrObjectTypeShapeIdentity([property('value', { kind: 'union', types: [numberType, numberType] })]),
    ).toBe(createIrObjectTypeShapeIdentity([property('value', numberType)]));
  });

  it('rejects duplicate properties, cycles, and non-finite literals through tagged failures', () => {
    const cyclic = { kind: 'array', readonly: false } as unknown as { element: IrType; kind: 'array'; readonly: false };
    cyclic.element = cyclic;
    const cases = [
      {
        code: 'duplicate-object-property',
        properties: [property('value', numberType), property('value', stringType)],
      },
      { code: 'cyclic-type', properties: [property('value', cyclic)] },
      { code: 'non-finite-literal', properties: [property('value', { kind: 'literal', value: Number.NaN })] },
    ] as const;

    for (const fixture of cases) {
      try {
        createIrObjectTypeShapeIdentity(fixture.properties);
        expect.unreachable(`Expected ${fixture.code} to fail`);
      } catch (error) {
        expect(isCompilerStructuralTypeShapeFailure(error)).toBe(true);
        expect(error).toMatchObject({ code: fixture.code, kind: 'compiler-structural-type-shape' });
      }
    }
  });
});

describe('isCompilerStructuralTypeShapeFailure', () => {
  it('accepts exact failures and rejects ordinary errors and malformed lookalikes', () => {
    let failure: unknown;
    try {
      createIrObjectTypeShapeIdentity([property('value', numberType), property('value', stringType)]);
    } catch (error) {
      failure = error;
    }

    expect(isCompilerStructuralTypeShapeFailure(failure)).toBe(true);
    expect(isCompilerStructuralTypeShapeFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerStructuralTypeShapeFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown',
          kind: 'compiler-structural-type-shape',
          path: [],
        }),
      ),
    ).toBe(false);
  });
});

function genericFunctionType(binding: IrTypeBindingIdentity): IrType {
  const reference = { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments: [] } as const;
  return {
    kind: 'function',
    parameters: [{ name: 'value', optional: false, rest: false, type: reference }],
    returns: reference,
    typeParameters: [{ binding }],
  };
}

function property(name: string, type: IrType, optional = false, readonly = false): IrObjectTypeProperty {
  return { name, optional, readonly, type };
}

function typeParameter(id: string, name: string): IrTypeBindingIdentity {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}`,
    id,
    kind: 'typeParameter',
    line: 1,
    name,
    packageName: '@flighthq/structural',
    scope: 'declaration',
    source: 'packages/structural/src/value.ts',
    space: 'type',
  };
}

function valueBinding(id: string, name: string): IrBindingIdentity {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}`,
    id,
    kind: 'variable',
    line: 1,
    name,
    packageName: '@flighthq/structural',
    scope: 'module',
    source: 'packages/structural/src/value.ts',
    space: 'value',
  };
}

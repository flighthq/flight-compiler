import type {
  CompilerStructuralTypeSubstitutionPlan,
  IrBindingIdentity,
  IrType,
  IrTypeBindingIdentity,
  IrTypeParameter,
} from '../../compiler-types/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from './compilerStructuralTypeSubstitution.js';

const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

describe('createIrTypeParameterSubstitutionPlan', () => {
  it('applies explicit arguments and sequential defaults without changing caller input', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const values = typeParameter('type-parameter:values', 'Values');
    const parameters: IrTypeParameter[] = [
      { binding: value },
      {
        binding: values,
        default: { element: typeReference(value), kind: 'array', readonly: true },
      },
    ];
    const arguments_: IrType[] = [numberType];
    const parametersSnapshot = structuredClone(parameters);
    const argumentsSnapshot = structuredClone(arguments_);

    const plan = createIrTypeParameterSubstitutionPlan(parameters, arguments_);

    expect(plan).toEqual({
      schema: 'flight-compiler-structural-type-substitution/1',
      substitutions: [
        { parameter: value, type: numberType },
        { parameter: values, type: { element: numberType, kind: 'array', readonly: true } },
      ],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.substitutions)).toBe(true);
    expect(plan.substitutions.every(Object.isFrozen)).toBe(true);
    expect(parameters).toEqual(parametersSnapshot);
    expect(arguments_).toEqual(argumentsSnapshot);
  });

  it('accepts exactly matching argument and parameter counts', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const plan = createIrTypeParameterSubstitutionPlan([{ binding: value }], [numberType]);
    expect(plan.substitutions).toEqual([{ parameter: value, type: numberType }]);
  });

  it('rejects missing, excess, and duplicate parameter applications through stable paths', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const cases = [
      {
        code: 'missing-type-argument',
        run: () => createIrTypeParameterSubstitutionPlan([{ binding: value }], []),
      },
      {
        code: 'too-many-type-arguments',
        run: () => createIrTypeParameterSubstitutionPlan([], [numberType]),
      },
      {
        code: 'duplicate-type-parameter',
        run: () =>
          createIrTypeParameterSubstitutionPlan(
            [{ binding: value }, { binding: { ...value, name: 'Duplicate' }, default: stringType }],
            [numberType],
          ),
      },
    ] as const;

    for (const fixture of cases) {
      expect(fixture.run).toThrow(
        expect.objectContaining({ code: fixture.code, kind: 'compiler-structural-type-substitution' }),
      );
    }
  });
});

describe('isCompilerStructuralTypeSubstitutionFailure', () => {
  it('accepts every exact failure code and rejects malformed lookalikes', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const failures: unknown[] = [];
    const attempts = [
      () => createIrTypeParameterSubstitutionPlan([{ binding: value }], []),
      () => createIrTypeParameterSubstitutionPlan([], [numberType]),
      () =>
        createIrTypeParameterSubstitutionPlan(
          [{ binding: value }, { binding: value, default: stringType }],
          [numberType],
        ),
      () =>
        resolveIrTypeStructuralSubstitution(typeReference(value), {
          schema: 'invalid',
          substitutions: [],
        } as unknown as CompilerStructuralTypeSubstitutionPlan),
      () =>
        resolveIrTypeStructuralSubstitution(
          { ...typeReference(value), reference: { ...typeReference(value).reference, path: ['Nested'] } },
          plan([{ parameter: value, type: numberType }]),
        ),
      () =>
        resolveIrTypeStructuralSubstitution(
          typeReference(value),
          plan([{ parameter: value, type: typeReference(value) }]),
        ),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    expect(failures.every(isCompilerStructuralTypeSubstitutionFailure)).toBe(true);
    expect(isCompilerStructuralTypeSubstitutionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerStructuralTypeSubstitutionFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown',
          kind: 'compiler-structural-type-substitution',
          path: [],
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveIrTypeStructuralSubstitution', () => {
  it('substitutes recursively through every compound type while preserving nested generic shadowing', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const inner = typeParameter('type-parameter:inner', 'Inner');
    const host = valueBinding('binding:host', 'host');
    const input: IrType = {
      kind: 'object',
      properties: [
        property('array', { element: typeReference(value), kind: 'array', readonly: false }),
        property('callback', {
          kind: 'function',
          parameters: [{ name: 'inner', optional: false, rest: false, type: typeReference(inner) }],
          returns: typeReference(value),
          typeParameters: [
            {
              binding: inner,
              constraint: typeReference(value),
              default: typeReference(inner),
            },
          ],
        }),
        property('indexed', {
          index: { kind: 'keyof', type: typeReference(value) },
          kind: 'indexedAccess',
          object: typeReference(value),
        }),
        property('intersection', {
          kind: 'intersection',
          types: [typeReference(value), { kind: 'object', properties: [] }],
        }),
        property('named', {
          kind: 'named',
          reference: { kind: 'ambient', name: 'Promise' },
          typeArguments: [typeReference(value)],
        }),
        property('tuple', {
          elements: [{ optional: false, rest: false, type: typeReference(value) }],
          kind: 'tuple',
          readonly: true,
        }),
        property('typeOfAmbient', { kind: 'typeOf', reference: { kind: 'ambient', name: 'Host' } }),
        property('typeOfBinding', { kind: 'typeOf', reference: { binding: host, kind: 'binding', path: ['value'] } }),
        property('union', { kind: 'union', types: [typeReference(value), { kind: 'null' }] }),
        property('literal', { kind: 'literal', value: 'ready' }),
        property('never', { kind: 'never' }),
        property('undefined', { kind: 'undefined' }),
        property('unknown', { kind: 'unknown', source: 'unknown' }),
      ],
    };
    const snapshot = structuredClone(input);
    const substitutions = plan([
      { parameter: value, type: numberType },
      { parameter: inner, type: stringType },
    ]);

    const output = resolveIrTypeStructuralSubstitution(input, substitutions);

    expect(output).toMatchObject({
      kind: 'object',
      properties: [
        { type: { element: numberType, kind: 'array' } },
        {
          type: {
            parameters: [{ type: { reference: { binding: { id: inner.id } } } }],
            returns: numberType,
            typeParameters: [
              {
                constraint: numberType,
                default: { reference: { binding: { id: inner.id } } },
              },
            ],
          },
        },
        { type: { index: { type: numberType }, object: numberType } },
        { type: { types: [numberType, { kind: 'object' }] } },
        { type: { typeArguments: [numberType] } },
        { type: { elements: [{ type: numberType }] } },
        { type: { kind: 'typeOf', reference: { kind: 'ambient' } } },
        { type: { kind: 'typeOf', reference: { kind: 'binding', path: ['value'] } } },
        { type: { types: [numberType, { kind: 'null' }] } },
        { type: { kind: 'literal' } },
        { type: { kind: 'never' } },
        { type: { kind: 'undefined' } },
        { type: { kind: 'unknown' } },
      ],
    });
    expect(output).not.toBe(input);
    expect(input).toEqual(snapshot);
  });

  it('resolves substitution chains and rejects cyclic or qualified substituted references', () => {
    const first = typeParameter('type-parameter:first', 'First');
    const second = typeParameter('type-parameter:second', 'Second');
    const local = typeParameter('type-parameter:local', 'Local');

    expect(
      resolveIrTypeStructuralSubstitution(
        typeReference(first),
        plan([
          { parameter: first, type: typeReference(second) },
          { parameter: second, type: numberType },
        ]),
      ),
    ).toEqual(numberType);
    expect(
      resolveIrTypeStructuralSubstitution(
        {
          kind: 'function',
          parameters: [],
          returns: typeReference(first),
          typeParameters: [{ binding: local }],
        },
        plan([{ parameter: first, type: numberType }]),
      ),
    ).toMatchObject({ returns: numberType, typeParameters: [{ binding: { id: local.id } }] });
    expect(() =>
      resolveIrTypeStructuralSubstitution(
        typeReference(first),
        plan([
          { parameter: first, type: typeReference(second) },
          { parameter: second, type: typeReference(first) },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: 'cyclic-type-substitution' }));
    expect(() =>
      resolveIrTypeStructuralSubstitution(
        { ...typeReference(first), typeArguments: [numberType] },
        plan([{ parameter: first, type: numberType }]),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-type-parameter-reference' }));
  });

  it('rejects cyclic runtime type graphs through the exact traversal path', () => {
    const cyclic = { kind: 'array', readonly: false } as unknown as {
      element: IrType;
      kind: 'array';
      readonly: false;
    };
    cyclic.element = cyclic;

    expect(() => resolveIrTypeStructuralSubstitution(cyclic, plan([]))).toThrow(
      expect.objectContaining({
        code: 'cyclic-type-substitution',
        path: ['element'],
      }),
    );
  });

  it('rejects malformed plan schemas, arrays, parameters, spaces, and duplicates', () => {
    const value = typeParameter('type-parameter:value', 'Value');
    const invalidPlans = [
      { schema: 'invalid', substitutions: [] },
      { schema: 'flight-compiler-structural-type-substitution/1', substitutions: null },
      plan([{ parameter: { ...value, kind: 'interface' }, type: numberType }]),
      plan([{ parameter: { ...value, space: 'value' }, type: numberType }] as never),
      plan([
        { parameter: value, type: numberType },
        { parameter: value, type: stringType },
      ]),
    ];

    for (const invalid of invalidPlans) {
      expect(() =>
        resolveIrTypeStructuralSubstitution(numberType, invalid as unknown as CompilerStructuralTypeSubstitutionPlan),
      ).toThrow(expect.objectContaining({ code: 'invalid-substitution-plan' }));
    }
  });
});

function plan(
  substitutions: CompilerStructuralTypeSubstitutionPlan['substitutions'],
): CompilerStructuralTypeSubstitutionPlan {
  return { schema: 'flight-compiler-structural-type-substitution/1', substitutions };
}

function property(name: string, type: IrType) {
  return { name, optional: false, readonly: false, type } as const;
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

function typeReference(binding: IrTypeBindingIdentity) {
  return {
    kind: 'named',
    reference: { binding, kind: 'binding', path: [] },
    typeArguments: [],
  } as const;
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

import type {
  IrFunctionTypeParameter,
  IrObjectTypeProperty,
  IrTupleTypeElement,
  IrType,
} from '../../compiler-types/src/index.js';
import {
  analyzeIrTypeStructuralAssignability,
  isCompilerStructuralTypeAssignabilityFailure,
} from './compilerStructuralTypeAssignability.js';

const booleanType = { kind: 'primitive', name: 'boolean' } as const satisfies IrType;
const numberType = { kind: 'primitive', name: 'number' } as const satisfies IrType;
const stringType = { kind: 'primitive', name: 'string' } as const satisfies IrType;

function codes(source: IrType, target: IrType) {
  const report = analyzeIrTypeStructuralAssignability(source, target);
  return { codes: report.diagnostics.map((diagnostic) => diagnostic.code), status: report.status };
}

function object(properties: readonly IrObjectTypeProperty[]): IrType {
  return { kind: 'object', properties };
}

function property(name: string, type: IrType, changes: Partial<IrObjectTypeProperty> = {}): IrObjectTypeProperty {
  return { name, optional: false, readonly: false, type, ...changes };
}

function parameter(type: IrType, changes: Partial<IrFunctionTypeParameter> = {}): IrFunctionTypeParameter {
  return { optional: false, rest: false, type, ...changes } as IrFunctionTypeParameter;
}

function tuple(elements: readonly IrTupleTypeElement[], readonly = false): IrType {
  return { elements, kind: 'tuple', readonly };
}

describe('analyzeIrTypeStructuralAssignability', () => {
  it('handles literal widening, exact primitives, never, and unknown evidence', () => {
    expect(codes({ kind: 'literal', value: 1 }, numberType)).toEqual({ codes: [], status: 'compatible' });
    expect(codes({ kind: 'literal', value: true }, booleanType)).toEqual({ codes: [], status: 'compatible' });
    expect(codes(numberType, { kind: 'literal', value: 1 })).toEqual({
      codes: ['type-incompatible'],
      status: 'incompatible',
    });
    expect(codes({ kind: 'never' }, stringType)).toEqual({ codes: [], status: 'compatible' });
    expect(codes({ kind: 'unknown', source: 'unknown' }, numberType)).toEqual({
      codes: ['unknown-type-indeterminate'],
      status: 'indeterminate',
    });
    expect(codes(numberType, { kind: 'unknown', source: 'unknown' })).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(codes({ kind: 'unknown', source: 'object' }, { kind: 'unknown', source: 'object' })).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(
      codes(
        { kind: 'union', types: [{ kind: 'unknown', source: 'object' }, { kind: 'null' }] },
        { kind: 'union', types: [{ kind: 'unknown', source: 'object' }, { kind: 'null' }] },
      ),
    ).toEqual({ codes: [], status: 'compatible' });
    expect(codes({ kind: 'literal', value: 'left' }, { kind: 'literal', value: 'right' })).toEqual({
      codes: ['type-incompatible'],
      status: 'incompatible',
    });
    expect(codes({ kind: 'literal', value: 'same' }, { kind: 'literal', value: 'same' })).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(codes({ kind: 'null' }, { kind: 'null' })).toEqual({ codes: [], status: 'compatible' });
    expect(codes({ kind: 'undefined' }, { kind: 'undefined' })).toEqual({ codes: [], status: 'compatible' });
    expect(codes({ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' })).toEqual({
      codes: ['type-incompatible'],
      status: 'incompatible',
    });
    const mismatchedKinds: readonly IrType[] = [
      { element: numberType, kind: 'array', readonly: false },
      { kind: 'function', parameters: [], returns: numberType, typeParameters: [] },
      { kind: 'null' },
      object([]),
      tuple([]),
      { kind: 'undefined' },
    ];
    for (const source of mismatchedKinds) {
      expect(codes(source, stringType)).toEqual({ codes: ['type-incompatible'], status: 'incompatible' });
    }
  });

  it('preserves required, optional, readonly, callable, and extra property evidence', () => {
    const target = object([
      property('value', numberType),
      property('label', stringType, { optional: true, readonly: true }),
    ]);
    expect(
      codes(
        object([property('value', numberType), property('label', stringType), property('extra', booleanType)]),
        target,
      ),
    ).toEqual({ codes: [], status: 'compatible' });
    expect(codes(object([]), target)).toEqual({ codes: ['missing-required-property'], status: 'incompatible' });
    expect(codes(object([property('value', numberType, { optional: true })]), target)).toEqual({
      codes: ['optional-member-incompatible'],
      status: 'incompatible',
    });
    expect(codes(object([property('value', numberType, { readonly: true })]), target)).toEqual({
      codes: ['readonly-member-incompatible'],
      status: 'incompatible',
    });
    expect(codes(object([property('value', stringType)]), target)).toEqual({
      codes: ['type-incompatible'],
      status: 'incompatible',
    });
    expect(codes(object([property('value', { kind: 'unknown', source: 'this' })]), target)).toEqual({
      codes: ['unknown-type-indeterminate'],
      status: 'indeterminate',
    });
  });

  it('keeps mutable arrays invariant and enforces tuple readonly, optionality, rest, and cardinality', () => {
    expect(
      codes(
        { element: numberType, kind: 'array', readonly: false },
        { element: numberType, kind: 'array', readonly: true },
      ),
    ).toEqual({ codes: [], status: 'compatible' });
    expect(
      codes(
        { element: numberType, kind: 'array', readonly: true },
        { element: numberType, kind: 'array', readonly: false },
      ),
    ).toEqual({ codes: ['readonly-container-incompatible'], status: 'incompatible' });
    expect(
      codes(
        { element: { kind: 'literal', value: 1 }, kind: 'array', readonly: false },
        { element: numberType, kind: 'array', readonly: false },
      ),
    ).toEqual({ codes: ['type-incompatible'], status: 'incompatible' });
    expect(
      codes(
        tuple([parameter(numberType), parameter(stringType)]),
        tuple([parameter(numberType), parameter(stringType)]),
      ),
    ).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(codes(tuple([parameter(numberType)], true), tuple([parameter(numberType)]))).toEqual({
      codes: ['readonly-container-incompatible'],
      status: 'incompatible',
    });
    expect(codes(tuple([parameter(numberType, { optional: true })]), tuple([parameter(numberType)]))).toEqual({
      codes: ['tuple-cardinality-incompatible'],
      status: 'incompatible',
    });
    expect(codes(tuple([parameter(numberType), parameter(stringType)]), tuple([parameter(numberType)]))).toEqual({
      codes: ['tuple-cardinality-incompatible'],
      status: 'incompatible',
    });
    expect(
      codes(
        tuple([parameter(numberType), parameter(stringType)]),
        tuple([parameter(numberType), parameter(stringType, { rest: true })]),
      ),
    ).toEqual({ codes: [], status: 'compatible' });
    expect(
      codes(
        tuple([parameter(numberType), parameter(stringType, { rest: true })]),
        tuple([parameter(numberType), parameter(stringType, { rest: true })]),
      ),
    ).toEqual({ codes: [], status: 'compatible' });

    const extraFixed = analyzeIrTypeStructuralAssignability(
      tuple([parameter(numberType), parameter(stringType), parameter(booleanType)]),
      tuple([parameter(numberType), parameter(numberType, { rest: true })]),
    );
    expect(extraFixed.status).toBe('incompatible');
    expect(extraFixed.diagnostics.map((d) => ({ code: d.code, path: d.path }))).toEqual([
      { code: 'type-incompatible', path: ['elements', 1] },
      { code: 'type-incompatible', path: ['elements', 2] },
    ]);
  });

  it('checks callable inputs contravariantly, outputs covariantly, and cardinality explicitly', () => {
    const callable = (parameters: readonly IrFunctionTypeParameter[], returns: IrType, generic = false): IrType => ({
      kind: 'function',
      parameters,
      returns,
      typeParameters: generic
        ? [
            {
              binding: {
                column: 1,
                fingerprint: 'sha256:parameter',
                id: 'type-parameter:value',
                kind: 'typeParameter',
                line: 1,
                name: 'Value',
                packageName: '@flighthq/structural',
                scope: 'declaration',
                source: 'assignability.ts',
                space: 'type',
              },
            },
          ]
        : [],
    });
    expect(
      codes(
        callable([parameter(numberType)], { kind: 'literal', value: 1 }),
        callable([parameter({ kind: 'literal', value: 1 })], numberType),
      ),
    ).toEqual({ codes: [], status: 'compatible' });
    expect(
      codes(
        callable([parameter({ kind: 'literal', value: 1 })], numberType),
        callable([parameter(numberType)], numberType),
      ),
    ).toEqual({ codes: ['type-incompatible'], status: 'incompatible' });
    expect(
      codes(
        callable([parameter(numberType), parameter(stringType)], numberType),
        callable([parameter(numberType)], numberType),
      ),
    ).toEqual({ codes: ['callable-parameter-cardinality-incompatible'], status: 'incompatible' });
    expect(
      codes(
        callable([parameter(numberType)], numberType),
        callable([parameter(numberType, { rest: true })], numberType),
      ),
    ).toEqual({ codes: ['callable-parameter-cardinality-incompatible'], status: 'incompatible' });
    expect(codes(callable([], numberType), callable([parameter(numberType, { rest: true })], numberType))).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(
      codes(
        callable([parameter(numberType, { rest: true })], numberType),
        callable([parameter(numberType)], numberType),
      ),
    ).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(codes(callable([], numberType), callable([parameter(numberType, { optional: true })], numberType))).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(codes(callable([], numberType, true), callable([], numberType))).toEqual({
      codes: ['generic-callable-indeterminate'],
      status: 'indeterminate',
    });
  });

  it('requires every source-union branch and accepts one proven target-union branch', () => {
    const sourceUnion = { kind: 'union', types: [numberType, stringType] } as const satisfies IrType;
    const targetUnion = { kind: 'union', types: [numberType, stringType] } as const satisfies IrType;
    const unresolved = {
      kind: 'named',
      reference: { kind: 'ambient', name: 'Remote' },
      typeArguments: [],
    } as const satisfies IrType;

    expect(codes(sourceUnion, numberType)).toEqual({ codes: ['type-incompatible'], status: 'incompatible' });
    expect(codes({ kind: 'literal', value: 'value' }, targetUnion)).toEqual({ codes: [], status: 'compatible' });
    expect(codes(booleanType, targetUnion)).toEqual({ codes: ['union-target-incompatible'], status: 'incompatible' });
    expect(codes(unresolved, { kind: 'union', types: [numberType, unresolved] })).toEqual({
      codes: [],
      status: 'compatible',
    });
    expect(
      codes(unresolved, {
        kind: 'union',
        types: [numberType, { ...unresolved, reference: { kind: 'ambient', name: 'Other' } }],
      }),
    ).toEqual({ codes: ['union-target-indeterminate'], status: 'indeterminate' });
  });

  it('keeps named identity and unresolved type operators explicit', () => {
    const named = (name: string, argument: IrType): IrType => ({
      kind: 'named',
      reference: { kind: 'ambient', name },
      typeArguments: [argument],
    });
    expect(codes(named('Box', numberType), named('Box', numberType))).toEqual({ codes: [], status: 'compatible' });
    expect(codes(named('Box', { kind: 'literal', value: 1 }), named('Box', numberType))).toEqual({
      codes: ['type-incompatible'],
      status: 'incompatible',
    });
    expect(codes(named('Box', numberType), named('Other', numberType))).toEqual({
      codes: ['named-type-indeterminate'],
      status: 'indeterminate',
    });
    const bindingReference = {
      binding: {
        column: 1,
        fingerprint: 'sha256:binding',
        id: 'type-alias:box',
        kind: 'typeAlias',
        line: 1,
        name: 'Box',
        packageName: '@flighthq/structural',
        scope: 'module',
        source: 'assignability.ts',
        space: 'type',
      },
      kind: 'binding',
      path: ['Member'],
    } as const;
    const bound = { kind: 'named', reference: bindingReference, typeArguments: [] } as const satisfies IrType;
    expect(codes(bound, structuredClone(bound))).toEqual({ codes: [], status: 'compatible' });

    const operators: readonly IrType[] = [
      { index: stringType, kind: 'indexedAccess', object: object([]) },
      { kind: 'intersection', types: [object([]), object([property('value', numberType)])] },
      { kind: 'keyof', type: object([]) },
      { kind: 'typeOf', reference: { kind: 'ambient', name: 'value' } },
    ];
    for (const operator of operators) {
      expect(codes(operator, structuredClone(operator))).toEqual({
        codes: ['type-operator-indeterminate'],
        status: 'indeterminate',
      });
    }
    expect(codes(operators[2]!, stringType)).toEqual({ codes: ['type-incompatible'], status: 'incompatible' });
  });

  it('diagnoses malformed runtime arguments without throwing or mutating them', () => {
    const malformed = [
      [null, numberType],
      [numberType, null],
      [1, numberType],
      [numberType, 1],
    ] as const;
    for (const [source, target] of malformed) {
      expect(codes(source as unknown as IrType, target as unknown as IrType)).toEqual({
        codes: ['type-incompatible'],
        status: 'incompatible',
      });
    }
  });

  it('returns a deterministic deeply immutable report without changing either input', () => {
    const source = object([property('value', numberType)]);
    const target = object([property('value', stringType)]);
    const snapshot = structuredClone([source, target]);

    const report = analyzeIrTypeStructuralAssignability(source, target);

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.diagnostics)).toBe(true);
    expect(report.diagnostics.every(Object.isFrozen)).toBe(true);
    expect(report.diagnostics.every((diagnostic) => Object.isFrozen(diagnostic.path))).toBe(true);
    expect(analyzeIrTypeStructuralAssignability(source, target)).toEqual(report);
    expect([source, target]).toEqual(snapshot);
  });
});

describe('isCompilerStructuralTypeAssignabilityFailure', () => {
  it('accepts cyclic and duplicate-property failures and rejects malformed lookalikes', () => {
    const cyclic = object([]) as { kind: 'object'; properties: IrObjectTypeProperty[] };
    cyclic.properties.push(property('self', cyclic));
    const duplicate = object([property('value', numberType), property('value', stringType)]);
    const failures: unknown[] = [];
    for (const attempt of [
      () => analyzeIrTypeStructuralAssignability(cyclic, cyclic),
      () => analyzeIrTypeStructuralAssignability(duplicate, object([])),
    ]) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(2);
    expect(failures.every(isCompilerStructuralTypeAssignabilityFailure)).toBe(true);
    for (const value of [
      undefined,
      new Error('ordinary'),
      Object.assign(new Error('lookalike'), { kind: 'compiler-structural-type-assignability' }),
      Object.assign(new Error('lookalike'), {
        code: 'unknown',
        kind: 'compiler-structural-type-assignability',
        path: [],
      }),
      Object.assign(new Error('lookalike'), {
        code: 'cyclic-type',
        kind: 'compiler-structural-type-assignability',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'cyclic-type',
        kind: 'compiler-structural-type-assignability',
        path: 'properties',
      }),
      Object.assign(new Error('lookalike'), {
        code: 'cyclic-type',
        kind: 'compiler-structural-type-assignability',
        path: [false],
      }),
    ]) {
      expect(isCompilerStructuralTypeAssignabilityFailure(value)).toBe(false);
    }
  });
});

import type { IrType, IrTypeReference } from '../../compiler-types/src/index.js';
import { createCppUnionRepresentationPlan } from './cppUnionRepresentationPlan.js';

describe('createCppUnionRepresentationPlan', () => {
  it('elects all five C++ value, optional, variant, and sentinel construction shapes', () => {
    const single = createPlan(union(literal('first'), literal('second')));
    expect(single).toMatchObject({
      construction: { kind: 'direct', valueSlot: 0 },
      kind: 'singleValue',
      sentinels: { null: 'absent', undefined: 'absent' },
      valueSlots: [{ sourceRelationship: 'runtimeEquivalent', targetType: 'std::string' }],
    });

    const optionalSingle = createPlan(union(primitive('number'), { kind: 'undefined' }));
    expect(optionalSingle).toMatchObject({
      construction: {
        absence: 'undefined',
        kind: 'optional',
        payload: { kind: 'single', valueSlot: 0 },
      },
      kind: 'optionalSingle',
      sentinels: { null: 'absent', undefined: 'optionalAbsence' },
    });

    const multiVariant = createPlan(union(primitive('string'), primitive('number')));
    expect(multiVariant).toMatchObject({
      construction: {
        alternatives: [
          { kind: 'value', valueSlot: 0 },
          { kind: 'value', valueSlot: 1 },
        ],
        kind: 'variant',
      },
      kind: 'multiVariant',
    });

    const optionalVariant = createPlan(union(primitive('string'), primitive('number'), { kind: 'undefined' }));
    expect(optionalVariant).toMatchObject({
      construction: {
        absence: 'undefined',
        kind: 'optional',
        payload: { kind: 'variant', valueSlots: [0, 1] },
      },
      kind: 'optionalVariant',
      sentinels: { null: 'absent', undefined: 'optionalAbsence' },
      valueSlots: [{ targetType: 'double' }, { targetType: 'std::string' }],
    });

    const dualSentinel = createPlan(union(primitive('number'), { kind: 'null' }, { kind: 'undefined' }));
    expect(dualSentinel).toMatchObject({
      construction: {
        alternatives: [{ kind: 'value', valueSlot: 0 }, { kind: 'nullSentinel' }, { kind: 'undefinedSentinel' }],
        kind: 'variant',
      },
      kind: 'dualSentinelVariant',
      sentinels: {
        distinction: 'preservedByDistinctAlternatives',
        null: 'variantAlternative',
        undefined: 'variantAlternative',
      },
    });
  });

  it('collapses aliases and literals only when they describe one runtime domain', () => {
    const numeric = namedAlias('Numeric');
    if (numeric.reference.kind !== 'binding') throw new Error('Expected a bound alias');
    const aliases = new Map([[numeric.reference.binding.id, primitive('number')]]);
    const collapsedAlias = createPlan(union(numeric, primitive('number')), aliases);

    expect(collapsedAlias).toMatchObject({
      construction: { kind: 'direct', valueSlot: 0 },
      kind: 'singleValue',
      valueSlots: [
        {
          runtimeType: { kind: 'primitive', name: 'number' },
          sourceAlternatives: [expect.objectContaining({ kind: 'named' }), { kind: 'primitive', name: 'number' }],
          sourceRelationship: 'runtimeEquivalent',
          targetType: 'double',
        },
      ],
    });

    const collapsedLiterals = createPlan(union(literal(1), literal(2), primitive('number')));
    expect(collapsedLiterals).toMatchObject({
      kind: 'singleValue',
      valueSlots: [
        {
          runtimeType: { kind: 'primitive', name: 'number' },
          sourceRelationship: 'runtimeEquivalent',
          targetType: 'double',
        },
      ],
    });

    const collision = createPlan(union(namedAmbient('First'), namedAmbient('Second')), new Map(), () => 'Same');
    expect(collision).toMatchObject({ kind: 'refused', reason: 'distinctRuntimeDomainsShareTargetType' });
    if (collision.kind !== 'refused') throw new Error('Expected an erased-distinction refusal');
    expect(collision.collisions).toHaveLength(1);
    expect(collision.collisions[0]?.targetType).toBe('Same');
    expect(
      collision.collisions[0]?.runtimeDomains.map((domain) =>
        domain.runtimeType.kind === 'named' && domain.runtimeType.reference.kind === 'ambient'
          ? domain.runtimeType.reference.name
          : undefined,
      ),
    ).toEqual(['First', 'Second']);
  });

  it('returns order-independent deeply immutable evidence without changing caller input', () => {
    const firstInput = union(primitive('string'), { kind: 'undefined' }, primitive('number'));
    const secondInput = union(primitive('number'), primitive('string'), { kind: 'undefined' });
    const before = structuredClone(firstInput);

    const first = createPlan(firstInput);
    const second = createPlan(secondInput);

    expect(first).toEqual(second);
    expect(firstInput).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.kind === 'refused') throw new Error('Expected a constructible union plan');
    expect(Object.isFrozen(first.valueSlots)).toBe(true);
    expect(Object.isFrozen(first.valueSlots[0]?.runtimeType)).toBe(true);
    expect(Object.isFrozen(first.construction)).toBe(true);
    expect(() => (first.valueSlots as unknown[]).push({})).toThrow();
  });
});

function createPlan(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  aliases: ReadonlyMap<string, Readonly<IrType>> = new Map(),
  resolveTargetType: (type: Readonly<IrType>) => string = getTargetType,
) {
  return createCppUnionRepresentationPlan(type, {
    resolveAliasTarget(typeReference) {
      return typeReference.reference.kind === 'binding' ? aliases.get(typeReference.reference.binding.id) : undefined;
    },
    resolveTargetType,
  });
}

function getTargetType(type: Readonly<IrType>): string {
  if (type.kind === 'primitive') {
    return {
      bigint: 'std::int64_t',
      boolean: 'bool',
      number: 'double',
      string: 'std::string',
      symbol: 'int',
      void: 'void',
    }[type.name];
  }
  if (type.kind === 'named') {
    return type.reference.kind === 'binding' ? type.reference.binding.name : type.reference.name;
  }
  return type.kind;
}

function literal(value: boolean | number | string): IrType {
  return { kind: 'literal', value };
}

function namedAlias(name: string): IrTypeReference {
  return {
    kind: 'named',
    reference: {
      binding: {
        column: 1,
        fingerprint: `sha256:${name}`,
        id: `type:${name}`,
        kind: 'typeAlias',
        line: 1,
        name,
        packageName: '@flighthq/example',
        scope: 'module',
        source: 'types.ts',
        space: 'type',
      },
      kind: 'binding',
      path: [],
    },
    typeArguments: [],
  };
}

function namedAmbient(name: string): IrTypeReference {
  return { kind: 'named', reference: { kind: 'ambient', name }, typeArguments: [] };
}

function primitive(name: Extract<IrType, { kind: 'primitive' }>['name']): IrType {
  return { kind: 'primitive', name };
}

function union(
  first: Readonly<IrType>,
  second: Readonly<IrType>,
  ...rest: readonly Readonly<IrType>[]
): Extract<IrType, { kind: 'union' }> {
  return { kind: 'union', types: [first, second, ...rest] };
}

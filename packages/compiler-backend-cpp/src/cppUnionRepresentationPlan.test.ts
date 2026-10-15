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

    const collapsedDiscriminants = createPlan(
      union(
        {
          kind: 'object',
          properties: [{ name: 'reason', optional: false, readonly: true, type: literal('ok') }],
        },
        {
          kind: 'object',
          properties: [
            {
              name: 'reason',
              optional: false,
              readonly: true,
              type: union(literal('blocked'), literal('missing')),
            },
          ],
        },
      ),
    );
    expect(collapsedDiscriminants).toMatchObject({
      kind: 'singleValue',
      valueSlots: [{ sourceRelationship: 'runtimeEquivalent', targetType: 'object' }],
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

  it('collapses only target-proven erased intersections and computed string domains', () => {
    const erasedString = {
      kind: 'intersection',
      types: [primitive('string'), { kind: 'object', properties: [] }],
    } as const satisfies IrType;
    const requestKeys = {
      kind: 'keyof',
      type: {
        kind: 'object',
        properties: [{ name: 'title', optional: false, readonly: false, type: primitive('string') }],
      },
    } as const satisfies IrType;
    const resolveRuntimeDomain = (type: Readonly<IrType>): Readonly<IrType> | undefined =>
      type.kind === 'intersection' || type.kind === 'keyof' ? primitive('string') : undefined;

    expect(
      createPlan(union(literal('known'), erasedString), new Map(), getTargetType, resolveRuntimeDomain),
    ).toMatchObject({
      kind: 'singleValue',
      valueSlots: [{ runtimeType: primitive('string'), sourceRelationship: 'runtimeEquivalent' }],
    });
    expect(createPlan(union(literal('at'), requestKeys), new Map(), getTargetType, resolveRuntimeDomain)).toMatchObject(
      {
        kind: 'singleValue',
        valueSlots: [{ runtimeType: primitive('string'), sourceRelationship: 'runtimeEquivalent' }],
      },
    );

    const unproven = createPlan(
      union(erasedString, namedAmbient('Opaque')),
      new Map(),
      () => 'std::string',
      resolveRuntimeDomain,
    );
    expect(unproven).toMatchObject({ kind: 'refused', reason: 'distinctRuntimeDomainsShareTargetType' });
  });

  it('preserves only imported aliases that contain a same-target union collision', () => {
    const resolver = namedImportedAlias('CanvasTextureResolver');
    const hostImage = namedImportedAlias('HostImageSource');
    const canvasImage = namedAmbient('CanvasImageSource');
    const textureSource = namedImportedAlias('TextureSourceValue');
    const kind = namedImportedAlias('TextureSourceKind');
    if (
      resolver.reference.kind !== 'binding' ||
      hostImage.reference.kind !== 'binding' ||
      textureSource.reference.kind !== 'binding' ||
      kind.reference.kind !== 'binding'
    ) {
      throw new Error('Expected imported aliases');
    }
    const aliases = new Map<string, Readonly<IrType>>([
      [
        resolver.reference.binding.id,
        {
          kind: 'function',
          parameters: [],
          returns: union(hostImage, { kind: 'null' }),
          typeParameters: [],
        },
      ],
      [hostImage.reference.binding.id, canvasImage],
      [textureSource.reference.binding.id, union(namedAmbient('Bitmap'), namedAmbient('ImageResource'))],
      [kind.reference.binding.id, primitive('string')],
    ]);
    const target = (type: Readonly<IrType>): string => {
      if (type === resolver) return 'flighthq_types::CanvasTextureResolver';
      if (type === textureSource) return 'flighthq_types::TextureSourceValue';
      if (type.kind === 'named' && type.reference.kind === 'ambient') {
        return type.reference.name === 'Bitmap' || type.reference.name === 'ImageResource'
          ? `flighthq_types::${type.reference.name}`
          : 'host::ImageSource';
      }
      return getTargetType(type);
    };

    expect(
      createPlan(
        union(resolver, { kind: 'undefined' }),
        aliases,
        target,
        () => undefined,
        (type) =>
          type.kind === 'named' && type.reference.kind === 'ambient' && type.reference.name === 'CanvasImageSource',
      ),
    ).toMatchObject({
      kind: 'optionalSingle',
      valueSlots: [{ runtimeType: resolver, targetType: 'flighthq_types::CanvasTextureResolver' }],
    });
    expect(createPlan(union(textureSource, { kind: 'null' }), aliases, target)).toMatchObject({
      kind: 'optionalVariant',
      valueSlots: [
        { runtimeType: namedAmbient('Bitmap'), targetType: 'flighthq_types::Bitmap' },
        { runtimeType: namedAmbient('ImageResource'), targetType: 'flighthq_types::ImageResource' },
      ],
    });
    expect(createPlan(union(kind, primitive('string')), aliases, target)).toMatchObject({
      kind: 'singleValue',
      valueSlots: [{ runtimeType: primitive('string'), targetType: 'std::string' }],
    });
  });

  it('terminates on a self-referential imported callable alias it cannot keep as a carrier', () => {
    const self = namedImportedAlias('SelfRecursive');
    if (self.reference.kind !== 'binding') throw new Error('Expected an imported alias');
    const aliases = new Map<string, Readonly<IrType>>([
      [
        self.reference.binding.id,
        {
          kind: 'function',
          parameters: [],
          returns: union(self, { kind: 'null' }),
          typeParameters: [],
        },
      ],
    ]);

    // The walk reaches its own return union again, and answers "no collision" for the shape it is
    // already deciding rather than recursing through it. Nothing here is an ABI carrier, so the
    // callable still flattens to the one value alternative the outer optional stores.
    expect(
      createPlan(
        union(self, { kind: 'null' }),
        aliases,
        () => 'Carrier',
        () => undefined,
        () => false,
      ),
    ).toMatchObject({
      kind: 'optionalSingle',
      valueSlots: [{ runtimeType: { kind: 'function' }, targetType: 'Carrier' }],
    });
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
  resolveRuntimeDomain: (type: Readonly<IrType>) => Readonly<IrType> | undefined = () => undefined,
  isExactAbiCarrier?: (type: Readonly<IrType>) => boolean,
) {
  return createCppUnionRepresentationPlan(type, {
    ...(isExactAbiCarrier ? { isExactAbiCarrier } : {}),
    resolveAliasTarget(typeReference) {
      return aliases.get(
        typeReference.reference.kind === 'binding'
          ? typeReference.reference.binding.id
          : `ambient:${typeReference.reference.name}`,
      );
    },
    resolveRuntimeDomain,
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

function namedImportedAlias(name: string): IrTypeReference {
  return {
    kind: 'named',
    reference: {
      binding: {
        column: 1,
        fingerprint: `sha256:${name}`,
        id: `import:${name}`,
        kind: 'import',
        line: 1,
        name,
        packageName: '@flighthq/consumer',
        scope: 'module',
        source: 'consumer.ts',
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

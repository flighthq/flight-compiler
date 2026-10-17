import type { IrType, IrTypeReference } from '../../compiler-types/src/index.js';
import { createRustUnionRepresentationPlan } from './rustUnionRepresentationPlan.js';

describe('createRustUnionRepresentationPlan', () => {
  it('resolves forwarding aliases to one nominal owner and maps exact source alternatives', () => {
    const handler = namedAlias('Handler');
    const slot = namedAlias('HandlerSlot');
    const forwarded = namedAlias('ForwardedSlot');
    const aliases = aliasMap(
      [handler, callable({ kind: 'primitive', name: 'number' })],
      [slot, union(handler, { kind: 'primitive', name: 'string' })],
      [forwarded, slot],
    );

    const plan = createPlan(forwarded, aliases);

    expect(plan).toMatchObject({
      kind: 'nominalEnum',
      owner: slot,
      sentinels: { kind: 'none', null: false, undefined: false },
      valueVariants: [
        {
          name: 'Handler',
          resolvedType: { kind: 'function' },
          sourceAlternative: handler,
          sourceAlternatives: [handler, expect.objectContaining({ kind: 'function' })],
        },
        {
          name: 'String',
          resolvedType: { kind: 'primitive', name: 'string' },
          sourceAlternatives: [{ kind: 'primitive', name: 'string' }],
        },
      ],
    });
  });

  it('flattens nested members while preserving deterministic variant order and sentinel layout', () => {
    const optional = namedAlias('OptionalSlot');
    const distinct = namedAlias('DistinctSlot');
    const aliases = aliasMap(
      [
        optional,
        union(
          { kind: 'primitive', name: 'string' },
          union({ kind: 'primitive', name: 'number' }, { kind: 'undefined' }),
        ),
      ],
      [
        distinct,
        union({ kind: 'null' }, union({ kind: 'primitive', name: 'number' }, { kind: 'undefined' }), {
          kind: 'primitive',
          name: 'number',
        }),
      ],
    );

    expect(createPlan(optional, aliases)).toMatchObject({
      kind: 'nominalEnum',
      orderedAlternatives: [
        { kind: 'value', name: 'String' },
        { kind: 'value', name: 'F64' },
        { kind: 'undefinedSentinel' },
      ],
      sentinels: { kind: 'optional', null: false, sentinel: 'undefined', undefined: true },
    });
    expect(createPlan(distinct, aliases)).toMatchObject({
      kind: 'nominalEnum',
      orderedAlternatives: [
        { kind: 'nullSentinel' },
        { kind: 'value', name: 'F64' },
        { kind: 'undefinedSentinel' },
        { kind: 'value', name: 'F642' },
      ],
      sentinels: { kind: 'distinct', null: true, undefined: true },
    });
  });

  it('refuses structural and cyclic owners without changing caller input', () => {
    const first = namedAlias('First');
    const second = namedAlias('Second');
    const aliases = aliasMap([first, second], [second, first]);
    const structural = union({ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' });
    const before = structuredClone(structural);

    expect(createPlan(structural, aliases)).toEqual({ kind: 'refused', reason: 'missingNominalOwner' });
    expect(createPlan(first, aliases)).toEqual({ kind: 'refused', reason: 'ambiguousNominalOwner' });
    expect(structural).toEqual(before);
  });

  it('returns deeply immutable evidence', () => {
    const slot = namedAlias('Slot');
    const aliases = aliasMap([
      slot,
      union({ kind: 'primitive', name: 'number' }, { kind: 'primitive', name: 'string' }),
    ]);

    const plan = createPlan(slot, aliases);

    expect(Object.isFrozen(plan)).toBe(true);
    if (plan.kind === 'refused') throw new Error('Expected a represented union');
    expect(Object.isFrozen(plan.owner)).toBe(true);
    expect(Object.isFrozen(plan.valueVariants)).toBe(true);
    expect(Object.isFrozen(plan.valueVariants[0]?.resolvedType)).toBe(true);
    expect(() => (plan.valueVariants as unknown[]).push({})).toThrow();
  });
});

function aliasMap(
  ...entries: readonly (readonly [Readonly<IrTypeReference>, Readonly<IrType>])[]
): ReadonlyMap<string, Readonly<IrType>> {
  return new Map(entries.map(([alias, target]) => [getBindingId(alias), target]));
}

function callable(parameter: Readonly<IrType>): Extract<IrType, { kind: 'function' }> {
  return {
    kind: 'function',
    parameters: [{ name: 'value', optional: false, rest: false, type: parameter }],
    returns: { kind: 'primitive', name: 'void' },
    typeParameters: [],
  };
}

function createPlan(type: Readonly<IrType>, aliases: ReadonlyMap<string, Readonly<IrType>>) {
  return createRustUnionRepresentationPlan(type, {
    resolveAliasTarget(reference) {
      return aliases.get(getBindingId(reference));
    },
    resolveVariantName(type) {
      if (type.kind === 'named') {
        return type.reference.kind === 'binding' ? type.reference.binding.name : type.reference.name;
      }
      if (type.kind === 'primitive') {
        return { bigint: 'I64', boolean: 'Bool', number: 'F64', string: 'String', symbol: 'Symbol', void: 'Void' }[
          type.name
        ];
      }
      return type.kind;
    },
  });
}

function getBindingId(type: Readonly<IrTypeReference>): string {
  if (type.reference.kind !== 'binding') throw new Error('Expected a bound type reference');
  return type.reference.binding.id;
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

function union(
  first: Readonly<IrType>,
  second: Readonly<IrType>,
  ...rest: readonly Readonly<IrType>[]
): Extract<IrType, { kind: 'union' }> {
  return { kind: 'union', types: [first, second, ...rest] };
}

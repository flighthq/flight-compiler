import { normalizeCompilerStructuralValueCanonical } from '../../compiler-canonical-form/src/index.js';
import type { IrType, IrTypeReference } from '../../compiler-types/src/index.js';

interface RustUnionRepresentationPlanningCapabilities {
  readonly resolveAliasTarget: (type: Readonly<IrTypeReference>) => Readonly<IrType> | undefined;
  readonly resolveVariantName: (type: Readonly<IrType>) => string;
}

type RustUnionRepresentationPlan =
  | Readonly<{
      kind: 'nominalEnum';
      orderedAlternatives: readonly RustUnionRepresentationAlternative[];
      owner: IrTypeReference;
      sentinels:
        | Readonly<{ kind: 'distinct'; null: true; undefined: true }>
        | Readonly<{ kind: 'none'; null: false; undefined: false }>
        | Readonly<{
            kind: 'optional';
            null: boolean;
            sentinel: 'null' | 'undefined';
            undefined: boolean;
          }>;
      valueVariants: readonly RustUnionRepresentationValueVariant[];
    }>
  | Readonly<{
      kind: 'refused';
      reason: 'ambiguousNominalOwner' | 'missingNominalOwner';
    }>;

type RustUnionRepresentationAlternative =
  | Readonly<{ kind: 'nullSentinel'; name: string; sourceAlternative: IrType }>
  | Readonly<{ kind: 'undefinedSentinel'; name: string; sourceAlternative: IrType }>
  | RustUnionRepresentationValueVariant;

interface RustUnionRepresentationValueVariant {
  readonly kind: 'value';
  readonly name: string;
  readonly representationKey: string;
  readonly resolvedType: IrType;
  readonly sourceAlternative: IrType;
  readonly sourceAlternatives: readonly IrType[];
}

interface RustUnionOwner {
  readonly owner: Readonly<IrTypeReference>;
  readonly union: Readonly<Extract<IrType, { kind: 'union' }>>;
}

export function createRustUnionRepresentationPlan(
  type: Readonly<IrType>,
  capabilities: Readonly<RustUnionRepresentationPlanningCapabilities>,
): RustUnionRepresentationPlan {
  const owner = getRustUnionOwner(type, capabilities, new Set());
  if (owner === 'ambiguous') {
    return cloneRustUnionRepresentationPlan({ kind: 'refused', reason: 'ambiguousNominalOwner' });
  }
  if (!owner) return cloneRustUnionRepresentationPlan({ kind: 'refused', reason: 'missingNominalOwner' });

  const names = new Map<string, number>();
  const orderedAlternatives = flattenRustUnionMembers(owner.union.types).flatMap(
    (sourceAlternative): RustUnionRepresentationAlternative[] => {
      if (sourceAlternative.kind === 'never') return [];
      const preferred = capabilities.resolveVariantName(sourceAlternative);
      const occurrence = (names.get(preferred) ?? 0) + 1;
      names.set(preferred, occurrence);
      const name = occurrence === 1 ? preferred : `${preferred}${String(occurrence)}`;
      if (sourceAlternative.kind === 'null') {
        return [{ kind: 'nullSentinel', name, sourceAlternative: structuredClone(sourceAlternative) }];
      }
      if (sourceAlternative.kind === 'undefined') {
        return [{ kind: 'undefinedSentinel', name, sourceAlternative: structuredClone(sourceAlternative) }];
      }
      const sourceAlternatives = resolveRustUnionSourceAlternatives(sourceAlternative, capabilities, new Set());
      const resolvedType = sourceAlternatives.at(-1) ?? sourceAlternative;
      return [
        {
          kind: 'value',
          name,
          representationKey: normalizeCompilerStructuralValueCanonical(resolvedType),
          resolvedType: structuredClone(resolvedType),
          sourceAlternative: structuredClone(sourceAlternative),
          sourceAlternatives: sourceAlternatives.map((alternative) => structuredClone(alternative)),
        },
      ];
    },
  );
  const valueVariants = orderedAlternatives.filter(
    (alternative): alternative is RustUnionRepresentationValueVariant => alternative.kind === 'value',
  );
  const hasNull = orderedAlternatives.some((alternative) => alternative.kind === 'nullSentinel');
  const hasUndefined = orderedAlternatives.some((alternative) => alternative.kind === 'undefinedSentinel');
  const sentinels =
    hasNull && hasUndefined
      ? ({ kind: 'distinct', null: true, undefined: true } as const)
      : hasNull || hasUndefined
        ? ({
            kind: 'optional',
            null: hasNull,
            sentinel: hasNull ? 'null' : 'undefined',
            undefined: hasUndefined,
          } as const)
        : ({ kind: 'none', null: false, undefined: false } as const);
  return cloneRustUnionRepresentationPlan({
    kind: 'nominalEnum',
    orderedAlternatives,
    owner: structuredClone(owner.owner),
    sentinels,
    valueVariants,
  });
}

function cloneRustUnionRepresentationPlan<T extends RustUnionRepresentationPlan>(plan: T): T {
  const clone = structuredClone(plan);
  freezeRustUnionRepresentationPlan(clone, new WeakSet());
  return clone;
}

function flattenRustUnionMembers(types: readonly Readonly<IrType>[]): readonly Readonly<IrType>[] {
  return types.flatMap((member) => (member.kind === 'union' ? flattenRustUnionMembers(member.types) : [member]));
}

function freezeRustUnionRepresentationPlan(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustUnionRepresentationPlan(child, seen);
  Object.freeze(value);
}

function getRustUnionOwner(
  type: Readonly<IrType>,
  capabilities: Readonly<RustUnionRepresentationPlanningCapabilities>,
  resolving: ReadonlySet<string>,
): RustUnionOwner | 'ambiguous' | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    type.reference.binding.space !== 'type'
  ) {
    return undefined;
  }
  const key = type.reference.binding.id;
  if (resolving.has(key)) return 'ambiguous';
  const target = capabilities.resolveAliasTarget(type);
  if (!target) return undefined;
  if (target.kind === 'union') return { owner: type, union: target };
  return getRustUnionOwner(target, capabilities, new Set(resolving).add(key));
}

function resolveRustUnionSourceAlternatives(
  type: Readonly<IrType>,
  capabilities: Readonly<RustUnionRepresentationPlanningCapabilities>,
  resolving: ReadonlySet<string>,
): readonly Readonly<IrType>[] {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    type.reference.binding.space !== 'type' ||
    resolving.has(type.reference.binding.id)
  ) {
    return [type];
  }
  const target = capabilities.resolveAliasTarget(type);
  // A union alias is a distinct nominal Rust carrier. Opening it here would claim that one of its
  // members can enter an outer enum without first constructing the inner owner.
  if (!target || target.kind === 'union') return [type];
  const resolved = resolveRustUnionSourceAlternatives(
    target,
    capabilities,
    new Set(resolving).add(type.reference.binding.id),
  );
  const alternatives = new Map<string, Readonly<IrType>>([
    [normalizeCompilerStructuralValueCanonical(type), type],
    ...resolved.map((alternative) => [normalizeCompilerStructuralValueCanonical(alternative), alternative] as const),
  ]);
  return [...alternatives.values()];
}

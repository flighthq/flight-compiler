import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import type { IrType, IrTypeReference } from '../../compiler-types/src/index.js';

type CppUnionConstruction =
  | Readonly<{ kind: 'direct'; valueSlot: number }>
  | Readonly<{
      absence: 'null' | 'undefined';
      kind: 'optional';
      payload:
        | Readonly<{ kind: 'single'; valueSlot: number }>
        | Readonly<{ kind: 'variant'; valueSlots: readonly number[] }>;
    }>
  | Readonly<{ alternatives: readonly CppUnionVariantAlternative[]; kind: 'variant' }>;

type CppUnionRepresentationPlan =
  | CppUnionRepresentationSuccess
  | Readonly<{
      collisions: readonly CppUnionTargetCollision[];
      kind: 'refused';
      reason: 'distinctRuntimeDomainsShareTargetType';
    }>;

interface CppUnionRepresentationPlanningCapabilities {
  readonly resolveAliasTarget: (type: Readonly<IrTypeReference>) => Readonly<IrType> | undefined;
  readonly resolveTargetType: (type: Readonly<IrType>) => string;
}

interface CppUnionRepresentationSuccess {
  readonly construction: CppUnionConstruction;
  readonly kind: 'dualSentinelVariant' | 'multiVariant' | 'optionalSingle' | 'optionalVariant' | 'singleValue';
  readonly sentinels: Readonly<{
    distinction: 'notApplicable' | 'preservedByDistinctAlternatives';
    null: 'absent' | 'optionalAbsence' | 'variantAlternative';
    undefined: 'absent' | 'optionalAbsence' | 'variantAlternative';
  }>;
  readonly valueSlots: readonly CppUnionRuntimeSlot[];
}

interface CppUnionRuntimeSlot {
  readonly representationKey: string;
  readonly runtimeType: IrType;
  readonly sourceAlternatives: readonly IrType[];
  readonly sourceRelationship: 'runtimeEquivalent' | 'single';
  readonly targetType: string;
}

interface CppUnionTargetCollision {
  readonly runtimeDomains: readonly Readonly<{
    representationKey: string;
    runtimeType: IrType;
    sourceAlternatives: readonly IrType[];
  }>[];
  readonly targetType: string;
}

type CppUnionVariantAlternative =
  | Readonly<{ kind: 'nullSentinel' }>
  | Readonly<{ kind: 'undefinedSentinel' }>
  | Readonly<{ kind: 'value'; valueSlot: number }>;

interface RuntimeAlternativeDraft {
  readonly representationKey: string;
  readonly runtimeType: Readonly<IrType>;
  readonly sourceAlternatives: Map<string, Readonly<IrType>>;
  readonly targetType: string;
}

interface RuntimeAlternativeInventory {
  hasNull: boolean;
  hasUndefined: boolean;
  readonly valueSlots: Map<string, RuntimeAlternativeDraft>;
}

export function createCppUnionRepresentationPlan(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  capabilities: Readonly<CppUnionRepresentationPlanningCapabilities>,
): CppUnionRepresentationPlan {
  const inventory: RuntimeAlternativeInventory = {
    hasNull: false,
    hasUndefined: false,
    valueSlots: new Map(),
  };
  for (const alternative of type.types) {
    collectRuntimeAlternativeCpp(alternative, alternative, capabilities, inventory, new Set());
  }

  const valueSlots = [...inventory.valueSlots.values()]
    .sort((left, right) => compareTextCodeUnits(left.representationKey, right.representationKey))
    .map((slot): CppUnionRuntimeSlot => {
      const sourceAlternatives = [...slot.sourceAlternatives.entries()]
        .sort(([left], [right]) => compareTextCodeUnits(left, right))
        .map(([, source]) => structuredClone(source));
      return {
        representationKey: slot.representationKey,
        runtimeType: structuredClone(slot.runtimeType),
        sourceAlternatives,
        sourceRelationship: sourceAlternatives.length === 1 ? 'single' : 'runtimeEquivalent',
        targetType: slot.targetType,
      };
    });
  const collisions = createCppUnionTargetCollisions(valueSlots);
  if (collisions.length > 0) {
    return cloneCppUnionRepresentationPlan({
      collisions,
      kind: 'refused',
      reason: 'distinctRuntimeDomainsShareTargetType',
    });
  }

  const plan = createCppUnionRepresentationSuccess(valueSlots, inventory.hasNull, inventory.hasUndefined);
  return cloneCppUnionRepresentationPlan(plan);
}

function cloneCppUnionRepresentationPlan<T extends CppUnionRepresentationPlan>(plan: T): T {
  const clone = structuredClone(plan);
  freezeCppUnionRepresentationPlan(clone, new WeakSet());
  return clone;
}

function collectRuntimeAlternativeCpp(
  type: Readonly<IrType>,
  sourceAlternative: Readonly<IrType>,
  capabilities: Readonly<CppUnionRepresentationPlanningCapabilities>,
  inventory: RuntimeAlternativeInventory,
  resolvingAliases: ReadonlySet<string>,
): void {
  if (type.kind === 'null') {
    inventory.hasNull = true;
    return;
  }
  if (type.kind === 'undefined') {
    inventory.hasUndefined = true;
    return;
  }
  if (type.kind === 'union') {
    for (const member of type.types) {
      collectRuntimeAlternativeCpp(member, sourceAlternative, capabilities, inventory, resolvingAliases);
    }
    return;
  }
  if (type.kind === 'named' && type.reference.kind === 'binding' && type.typeArguments.length === 0) {
    const bindingId = type.reference.binding.id;
    const aliasTarget = capabilities.resolveAliasTarget(type);
    if (aliasTarget && !resolvingAliases.has(bindingId)) {
      const nextResolvingAliases = new Set(resolvingAliases);
      nextResolvingAliases.add(bindingId);
      collectRuntimeAlternativeCpp(aliasTarget, sourceAlternative, capabilities, inventory, nextResolvingAliases);
      return;
    }
  }

  const runtimeType = widenIrLiteralTypeCpp(type);
  const representationKey = normalizeCompilerStructuralValueCanonical(runtimeType);
  const sourceKey = normalizeCompilerStructuralValueCanonical(sourceAlternative);
  const existing = inventory.valueSlots.get(representationKey);
  if (existing) {
    existing.sourceAlternatives.set(sourceKey, sourceAlternative);
    return;
  }
  inventory.valueSlots.set(representationKey, {
    representationKey,
    runtimeType,
    sourceAlternatives: new Map([[sourceKey, sourceAlternative]]),
    targetType: capabilities.resolveTargetType(runtimeType),
  });
}

function createCppUnionRepresentationSuccess(
  valueSlots: readonly CppUnionRuntimeSlot[],
  hasNull: boolean,
  hasUndefined: boolean,
): CppUnionRepresentationSuccess {
  const valueSlotIndexes = valueSlots.map((_, index) => index);
  if (hasNull && hasUndefined) {
    return {
      construction: {
        alternatives: [
          ...valueSlotIndexes.map((valueSlot): CppUnionVariantAlternative => ({ kind: 'value', valueSlot })),
          { kind: 'nullSentinel' },
          { kind: 'undefinedSentinel' },
        ],
        kind: 'variant',
      },
      kind: 'dualSentinelVariant',
      sentinels: {
        distinction: 'preservedByDistinctAlternatives',
        null: 'variantAlternative',
        undefined: 'variantAlternative',
      },
      valueSlots,
    };
  }
  if (hasNull || hasUndefined) {
    const absence = hasNull ? 'null' : 'undefined';
    return {
      construction: {
        absence,
        kind: 'optional',
        payload:
          valueSlots.length === 1
            ? { kind: 'single', valueSlot: 0 }
            : { kind: 'variant', valueSlots: valueSlotIndexes },
      },
      kind: valueSlots.length === 1 ? 'optionalSingle' : 'optionalVariant',
      sentinels: {
        distinction: 'notApplicable',
        null: hasNull ? 'optionalAbsence' : 'absent',
        undefined: hasUndefined ? 'optionalAbsence' : 'absent',
      },
      valueSlots,
    };
  }
  if (valueSlots.length === 1) {
    return {
      construction: { kind: 'direct', valueSlot: 0 },
      kind: 'singleValue',
      sentinels: { distinction: 'notApplicable', null: 'absent', undefined: 'absent' },
      valueSlots,
    };
  }
  return {
    construction: {
      alternatives: valueSlotIndexes.map((valueSlot) => ({ kind: 'value', valueSlot })),
      kind: 'variant',
    },
    kind: 'multiVariant',
    sentinels: { distinction: 'notApplicable', null: 'absent', undefined: 'absent' },
    valueSlots,
  };
}

function createCppUnionTargetCollisions(
  valueSlots: readonly CppUnionRuntimeSlot[],
): readonly CppUnionTargetCollision[] {
  const byTargetType = new Map<string, CppUnionRuntimeSlot[]>();
  for (const slot of valueSlots) {
    byTargetType.set(slot.targetType, [...(byTargetType.get(slot.targetType) ?? []), slot]);
  }
  return [...byTargetType.entries()]
    .filter(([, slots]) => slots.length > 1)
    .sort(([left], [right]) => compareTextCodeUnits(left, right))
    .map(([targetType, slots]) => ({
      runtimeDomains: slots.map((slot) => ({
        representationKey: slot.representationKey,
        runtimeType: slot.runtimeType,
        sourceAlternatives: slot.sourceAlternatives,
      })),
      targetType,
    }));
}

function freezeCppUnionRepresentationPlan(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCppUnionRepresentationPlan(child, seen);
  Object.freeze(value);
}

function widenIrLiteralTypeCpp(type: Readonly<IrType>): Readonly<IrType> {
  if (type.kind !== 'literal') return type;
  if (typeof type.value === 'boolean') return { kind: 'primitive', name: 'boolean' };
  if (typeof type.value === 'number') return { kind: 'primitive', name: 'number' };
  return { kind: 'primitive', name: 'string' };
}

export interface Runtime {
  readonly kind: string;
}

type RuntimeAlias = Runtime;
type NestedAlias = RuntimeAlias;
type Slot = string | Runtime;

// An alias names the alternative the union already stores, so the assertion identifies it however many
// names the alias chain went through, and the union it is spelled through is the same union either way.
export function narrowNested(value: string | Runtime): NestedAlias {
  return value as NestedAlias;
}

export function narrowFromAliasedUnion(value: Slot): RuntimeAlias {
  return value as RuntimeAlias;
}

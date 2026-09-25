import type { Aabb, Capsule, Circle, Obb, Shape } from './contextualUnionRemapShapes';

type ReadonlyShape =
  | Readonly<Circle & { kind: 'circle' }>
  | Readonly<Aabb & { kind: 'aabb' }>
  | Readonly<Obb & { kind: 'obb' }>
  | Readonly<Capsule & { kind: 'capsule' }>;

// The imported alias and the local Readonly expansion contain the same arms, but their canonical
// source spellings order the C++ variant differently. The conversion must retain every exact arm.
export function readonlyShape(value: Shape): ReadonlyShape {
  return value;
}

export function readonlyOptionalShape(value: Shape | null): ReadonlyShape | null {
  return value;
}

export function readonlyMaybeShape(value: Shape | null | undefined): ReadonlyShape | null | undefined {
  return value;
}

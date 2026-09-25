export interface Circle {
  radius: number;
}

export interface Aabb {
  min: number;
  max: number;
}

export interface Obb {
  center: number;
  rotation: number;
}

export interface Capsule {
  start: number;
  end: number;
  radius: number;
}

export type Shape =
  | (Circle & { kind: 'circle' })
  | (Aabb & { kind: 'aabb' })
  | (Obb & { kind: 'obb' })
  | (Capsule & { kind: 'capsule' });

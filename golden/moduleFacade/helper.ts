// The named type re-exports in the facade resolve through this sibling module. Keeping the provider in
// the fixture makes module evaluation and facade routing prove the same dependency identities.
export interface Shape {
  readonly area: number;
}

export interface Circle {
  readonly radius: number;
}

// The import target the fixture's committed goldens describe: a value function over the neutral
// numeric domain. Its body is unobservable in those goldens, so it stays the identity.
export function helper(value: number): number {
  return value;
}

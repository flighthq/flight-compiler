export const fallback: number = 4;

export function resolve(fallback: number): number {
  // eslint-disable-next-line no-shadow-restricted-names -- this fixture proves binding identity, not identifier style.
  const undefined: number = fallback;
  return undefined;
}

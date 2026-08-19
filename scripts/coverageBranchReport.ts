// Reads the branch and statement arms a coverage run never reached, out of Istanbul-shaped coverage
// JSON. This is a location list, not a score: an arm you write and test costs zero entries, so there
// is no ratio to game.
//
// What the list cannot tell you: an arm missing from it was TAKEN by some test, not necessarily
// CHECKED by one. A fixture can execute a branch and still be unable to distinguish correct behavior
// from broken. So an empty list means nobody has looked here, not that the code is verified — that is
// the question `npm run mutation` answers, and the two instruments are complements.

export interface CoverageLocation {
  readonly column: number;
  readonly line: number;
}

export interface CoverageFileEntry {
  readonly b?: Record<string, readonly number[]>;
  readonly branchMap?: Record<
    string,
    { readonly locations?: readonly { readonly start?: Partial<CoverageLocation> }[] }
  >;
  readonly path?: string;
  readonly s?: Record<string, number>;
  readonly statementMap?: Record<string, { readonly start?: Partial<CoverageLocation> }>;
}

export interface UnreachedArm {
  readonly kind: 'branch' | 'statement';
  readonly line: number;
  readonly path: string;
}

export function collectUnreachedArms(coverage: Readonly<Record<string, CoverageFileEntry>>): UnreachedArm[] {
  const arms: UnreachedArm[] = [];
  for (const [key, entry] of Object.entries(coverage)) {
    const path = entry.path ?? key;
    for (const [id, counts] of Object.entries(entry.b ?? {})) {
      counts.forEach((count, index) => {
        if (count > 0) return;
        const line = entry.branchMap?.[id]?.locations?.[index]?.start?.line;
        if (typeof line === 'number') arms.push({ kind: 'branch', line, path });
      });
    }
    for (const [id, count] of Object.entries(entry.s ?? {})) {
      if (count > 0) continue;
      const line = entry.statementMap?.[id]?.start?.line;
      if (typeof line === 'number') arms.push({ kind: 'statement', line, path });
    }
  }
  return dedupe(arms).sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind),
  );
}

function dedupe(arms: readonly UnreachedArm[]): UnreachedArm[] {
  const seen = new Map<string, UnreachedArm>();
  for (const arm of arms) seen.set(`${arm.path}\0${String(arm.line)}\0${arm.kind}`, arm);
  return [...seen.values()];
}

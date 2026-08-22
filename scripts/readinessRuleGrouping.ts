// The grouping half of the readiness report, kept apart from the executable so importing it reads
// nothing and prints nothing.

export interface ReadinessFixtureOutcome {
  readonly fixture: string;
  readonly rule?: string | undefined;
  readonly target: string;
  readonly verdict: 'emitted' | 'refused';
}

export interface ReadinessRuleCount {
  readonly fixtures: readonly string[];
  readonly rule: string;
  readonly target: string;
}

export function collectReadinessRuleCounts(
  outcomes: readonly Readonly<ReadinessFixtureOutcome>[],
): readonly ReadinessRuleCount[] {
  const grouped = new Map<string, { fixtures: string[]; rule: string; target: string }>();
  for (const outcome of outcomes) {
    if (outcome.verdict !== 'refused' || !outcome.rule) continue;
    const key = `${outcome.target} ${outcome.rule}`;
    const entry = grouped.get(key) ?? { fixtures: [], rule: outcome.rule, target: outcome.target };
    entry.fixtures.push(outcome.fixture);
    grouped.set(key, entry);
  }
  return [...grouped.values()]
    .map((entry) => ({ fixtures: [...entry.fixtures].sort(), rule: entry.rule, target: entry.target }))
    .sort(
      (left, right) =>
        right.fixtures.length - left.fixtures.length ||
        compareReadinessText(left.target, right.target) ||
        compareReadinessText(left.rule, right.rule),
    );
}

export function parseReadinessRefusalRule(message: string): string {
  // "<target> emission failed for <package>/<source>: <rule>" — the rule is what generalizes; the
  // module identity in front of it is what makes every message look unique.
  const separator = message.indexOf(': ');
  return (separator < 0 ? message : message.slice(separator + 2)).trim();
}

function compareReadinessText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

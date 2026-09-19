// The analysis half of the corpus issue census, kept apart from the executable so importing it reads
// nothing and prints nothing.
//
// `npm run readiness:corpus` ranks refusal FAMILIES by the modules they block, which answers "which rule
// is expensive". This answers the other question: how many distinct issues are there, who owns each, and
// what did a change do to that set.
//
// The distinction matters because a module count is the wrong unit for planning. It moves only when a
// fix happens to unblock a whole module, so it reads as progress that is not there and hides progress
// that is; an issue count moves once per fixed issue. A fix that turns one refusal into a different
// refusal moves neither count and is still real work, which is why the fingerprints below exist: they
// change when the SET of issues changes, so a set-level change is visible even when every total holds.
//
// Everything here reads the JSON ledgers a downstream run already wrote. Nothing generates, compiles, or
// invokes a toolchain.

import { createHash } from 'node:crypto';

import { classifyCorpusIssueLane } from './corpusIssueLane.js';
import type { CorpusIssueLane } from './corpusIssueLane.js';
import type { CorpusRefusalRecord } from './corpusRefusalAnalysis.js';

export interface CorpusCompilationRecord {
  readonly diagnostic: string;
  readonly header: string;
}

export interface CorpusIssueGroup {
  readonly identities: readonly string[];
  readonly key: string;
  readonly lane: CorpusIssueLane;
  readonly occurrences: number;
}

export interface CorpusIssueLaneTotal {
  readonly issues: number;
  readonly lane: CorpusIssueLane;
  readonly occurrences: number;
}

export interface CorpusFoundationSummary {
  readonly emittedModules: number;
  readonly identity: string;
  readonly issues: readonly Readonly<{ count: number; key: string }>[];
  readonly packages: readonly string[];
  readonly refusedModules: number;
  readonly sourceModules: number;
}

export interface CorpusPackageSummary {
  readonly emittedModules: number;
  readonly package: string;
  readonly refusedModules: number;
  readonly sourceModules: number;
}

// A dependency cascade is not a second issue; it is the first one seen twice. A module refuses because
// something it imports refused, and the ledger records one such edge per blocked module, so counting
// these as issues inflates the list more than twofold on the current corpus.
export function isCorpusRefusalCascade(reason: string): boolean {
  return /^dependency \S+ was refused for /u.test(reason);
}

// Keep what identifies the issue, drop what is only where it happened. A generated 16-hex struct name, a
// bare count, and the ledger's own `cpp emission failed for <module>:` prefix are per-site detail.
// Quoted types and member names are NOT: they are what makes `'String' has no member named 'to_lower_case'`
// a different job from the same diagnostic naming something else, so collapsing quotes would merge
// unrelated work into one row.
export function normalizeCorpusIssueMessage(message: string): string {
  return message
    .replace(/^[a-z]+ emission failed for \S+: /u, '')
    .replace(/\b[0-9a-f]{16}\b/gu, '<hash>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim();
}

// The census is over direct refusals and over compile diagnostics. A cascade has no key of its own, so
// callers drop those first with `isCorpusRefusalCascade`.
export function collectCorpusIssueGroups(
  entries: readonly Readonly<{ identity: string; message: string }>[],
): readonly CorpusIssueGroup[] {
  const groups = new Map<string, { identities: Set<string>; lane: CorpusIssueLane; occurrences: number }>();
  for (const entry of entries) {
    const key = normalizeCorpusIssueMessage(entry.message);
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.identities.add(entry.identity);
      continue;
    }
    groups.set(key, {
      identities: new Set([entry.identity]),
      lane: classifyCorpusIssueLane(entry.message),
      occurrences: 1,
    });
  }
  return [...groups]
    .sort((left, right) => right[1].occurrences - left[1].occurrences || (left[0] < right[0] ? -1 : 1))
    .map(([key, group]) => ({
      identities: [...group.identities].sort(),
      key,
      lane: group.lane,
      occurrences: group.occurrences,
    }));
}

// A set-level fingerprint: it changes when the SET of distinct issues changes and not when a fix merely
// moves occurrences between existing rows. Two runs that differ only in counts share a fingerprint, so a
// "did that do anything" question is one string comparison rather than a table diff.
export function createCorpusIssueFingerprint(groups: readonly CorpusIssueGroup[]): string {
  return createHash('sha256')
    .update(
      [...groups]
        .sort((left, right) => (left.key < right.key ? -1 : 1))
        .map((group) => `${group.key}\u0000${group.lane}`)
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 12);
}

export function collectCorpusIssueLaneTotals(groups: readonly CorpusIssueGroup[]): readonly CorpusIssueLaneTotal[] {
  const totals = new Map<CorpusIssueLane, { issues: number; occurrences: number }>();
  for (const group of groups) {
    const current = totals.get(group.lane) ?? { issues: 0, occurrences: 0 };
    totals.set(group.lane, {
      issues: current.issues + 1,
      occurrences: current.occurrences + group.occurrences,
    });
  }
  return [...totals]
    .map(([lane, total]) => ({ lane, ...total }))
    .sort((left, right) => right.issues - left.issues || (left.lane < right.lane ? -1 : 1));
}

// A foundational identity is a package name or a source module path. Entity, node, and host roots sit
// underneath most of the graph, so their issues are both the most transitive and the easiest to lose
// inside a larger family's count. Reporting them individually is the difference between knowing a root
// is blocked and inferring it.
export function isCorpusFoundationRecord(record: Readonly<CorpusRefusalRecord>, identity: string): boolean {
  return identity.startsWith('@')
    ? record.package === identity
    : record.module === identity || record.module.endsWith(`/${identity}`);
}

export function collectCorpusFoundations(
  packages: readonly CorpusPackageSummary[],
  refusals: readonly Readonly<CorpusRefusalRecord>[],
  foundations: readonly string[],
): readonly CorpusFoundationSummary[] {
  return foundations.map((identity) => {
    const matched = packages.filter((entry) => (identity.startsWith('@') ? entry.package === identity : false));
    const direct = refusals.filter(
      (record) => !isCorpusRefusalCascade(record.reason) && isCorpusFoundationRecord(record, identity),
    );
    const groups = collectCorpusIssueGroups(
      direct.map((record) => ({
        identity: `${record.module}:${String(record.line ?? 0)}`,
        message: record.reason,
      })),
    );
    return {
      emittedModules: matched.reduce((total, entry) => total + entry.emittedModules, 0),
      identity,
      issues: groups.map((group) => ({ count: group.occurrences, key: group.key })),
      packages: [...new Set(matched.map((entry) => entry.package))].sort(),
      refusedModules: matched.reduce((total, entry) => total + entry.refusedModules, 0),
      sourceModules: matched.reduce((total, entry) => total + entry.sourceModules, 0),
    };
  });
}

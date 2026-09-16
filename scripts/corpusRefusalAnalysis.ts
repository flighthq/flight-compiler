// The analysis half of the corpus readiness report, kept apart from the executable so importing it
// reads nothing and prints nothing.
//
// The Flight SDK corpus is measured downstream. Only a target repository can build the request the
// real run needs — the 154-package graph, its package targets, and its binding profiles — so
// `flight-cpp` performs the generation and writes manifest.json plus a refusal ledger. This turns
// that ledger into the two things neither the ledger nor `npm run readiness` produces: which
// refusal *families* exist, and how much of the corpus each family blocks.
//
// `npm run readiness` reads the committed golden corpus and so reports what the compiler already
// handles. This reads the SDK corpus and reports what it does not.

import { parseReadinessRefusalRule } from './readinessRuleGrouping.js';

export interface CorpusRefusalRecord {
  readonly code: string;
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly module: string;
  readonly package: string;
  readonly reason: string;
  readonly stage: string;
}

export interface CorpusRefusalLedger {
  readonly compilerRevision: string;
  readonly refusals: readonly Readonly<CorpusRefusalRecord>[];
  readonly schema: string;
  readonly sourceRevision: string;
}

export interface CorpusRefusalPayload {
  readonly count: number;
  readonly payload: string;
}

export interface CorpusRefusalFamily {
  readonly blockedDependents: number;
  readonly directModules: number;
  readonly family: string;
  readonly modules: readonly string[];
  readonly payloads: readonly CorpusRefusalPayload[];
}

export interface CorpusRefusalAnalysis {
  readonly directRefusals: number;
  readonly distinctRules: number;
  readonly families: readonly CorpusRefusalFamily[];
  readonly propagatedRefusals: number;
  readonly singletonFamilies: number;
}

// A refusal family is one rule with its variable payload removed, so that the same rule refusing
// forty modules reads as one thing to decide about rather than forty. Only the payloads the corpus
// has actually demonstrated are normalized; anything unmatched keeps its exact rule text as its own
// family, so a new parameterized rule shows up as a long tail rather than being silently merged
// into a neighbour. Adding a row is the whole cost of teaching this a new one.
// `payloadGroup` names the capture group holding the variable part, and `family` may reference a
// capture group as `$1`. A family that keeps a value in its text is one where the value *is* the
// decision — two lowering passes are two decisions — while a family that hides it behind `<...>`
// is one where the value is only the instance, so its members belong together.
const corpusRefusalFamilyPatterns: readonly Readonly<{
  family: string;
  pattern: RegExp;
  payloadGroup: number;
}>[] = [
  {
    family: 'runtime external symbol binding plan is incomplete (missing: <external symbol>)',
    pattern: /^runtime external symbol binding plan is incomplete \(missing: (.+)\)$/u,
    payloadGroup: 1,
  },
  {
    family: 'runtime external symbol binding plan is incomplete (duplicate: <external symbol>)',
    pattern: /^runtime external symbol binding plan is incomplete \(duplicate: (.+)\)$/u,
    payloadGroup: 1,
  },
  {
    family: 'anonymous object property <property> requires concrete C++ type evidence',
    pattern: /^anonymous object property (.+) requires concrete C\+\+ type evidence$/u,
    payloadGroup: 1,
  },
  {
    family: 'flight-cpp type position retains unresolved auto placeholder: <emitted type text>',
    pattern: /^flight-cpp type position retains unresolved auto placeholder: (.+)$/u,
    payloadGroup: 1,
  },
  {
    family: 'property <property> on a C++ variant requires proven union member access',
    pattern: /^property (.+) on a C\+\+ variant requires proven union member access$/u,
    payloadGroup: 1,
  },
  {
    family: 'captured referent mutation of <referent> requires a shared C++ reference representation',
    pattern: /^captured referent mutation of (.+) requires a shared C\+\+ reference representation$/u,
    payloadGroup: 1,
  },
  {
    family: 'contextual union value type <type> is not a represented runtime domain',
    pattern: /^contextual union value type (.+) is not a represented runtime domain$/u,
    payloadGroup: 1,
  },
  {
    family: 'union has distinct runtime domains erased by C++ target type <type>',
    pattern: /^union has distinct runtime domains erased by C\+\+ target type (.+)$/u,
    payloadGroup: 1,
  },
  {
    family: 'imported type <type> has $2',
    pattern: /^imported type (.+?) has (.+)$/u,
    payloadGroup: 1,
  },
  {
    family: 'narrowed member <member> must identify one C++ variant alternative',
    pattern: /^narrowed member (.+) must identify one C\+\+ variant alternative$/u,
    payloadGroup: 1,
  },
  {
    family: 'renamed value reexport <value> requires callable or storage alias lowering',
    pattern: /^renamed value reexport (.+) requires callable or storage alias lowering$/u,
    payloadGroup: 1,
  },
  {
    // A lowering failure arrives with its own module identity embedded after the outer one, so the
    // upstream prefix strip leaves `… failed for <package>/<source>: <detail>` as the rule text and
    // every module reads as its own rule. Drop the identity, keep the pass and the detail.
    family: 'Compiler lowering pass $1 failed: $2',
    pattern: /^Compiler lowering pass (.+?) failed for \S+: (.+)$/u,
    payloadGroup: 2,
  },
];

const corpusRefusalDependencyMarker = ' was refused for ';

export function analyzeCorpusRefusals(ledger: Readonly<CorpusRefusalLedger>): CorpusRefusalAnalysis {
  const direct: Readonly<CorpusRefusalRecord>[] = [];
  const dependentsByRefusedModule = new Map<string, Set<string>>();
  for (const refusal of ledger.refusals) {
    if (refusal.stage !== 'dependency') {
      direct.push(refusal);
      continue;
    }
    const blocked = getCorpusRefusalPropagationTarget(refusal.reason);
    if (blocked === undefined) continue;
    const dependents = dependentsByRefusedModule.get(blocked) ?? new Set<string>();
    dependents.add(getCorpusRefusalModuleKey(refusal));
    dependentsByRefusedModule.set(blocked, dependents);
  }

  const grouped = new Map<
    string,
    { blockedModules: Set<string>; directModules: number; modules: string[]; payloadCounts: Map<string, number> }
  >();
  for (const refusal of direct) {
    const rule = parseReadinessRefusalRule(refusal.reason);
    const family = getCorpusRefusalFamily(rule);
    const entry = grouped.get(family) ?? {
      blockedModules: new Set<string>(),
      directModules: 0,
      modules: [],
      payloadCounts: new Map<string, number>(),
    };
    entry.directModules += 1;
    entry.modules.push(getCorpusRefusalModuleKey(refusal));
    for (const blocked of collectCorpusRefusalBlockedModules(
      getCorpusRefusalModuleKey(refusal),
      dependentsByRefusedModule,
    )) {
      entry.blockedModules.add(blocked);
    }
    const payload = getCorpusRefusalFamilyPayload(rule);
    if (payload !== undefined) entry.payloadCounts.set(payload, (entry.payloadCounts.get(payload) ?? 0) + 1);
    grouped.set(family, entry);
  }

  const families = [...grouped.entries()]
    .map(([family, entry]): CorpusRefusalFamily => {
      return {
        blockedDependents: entry.blockedModules.size,
        directModules: entry.directModules,
        family,
        modules: [...entry.modules].sort(compareCorpusRefusalText),
        payloads: [...entry.payloadCounts.entries()]
          .map(([payload, count]): CorpusRefusalPayload => ({ count, payload }))
          .sort((left, right) => right.count - left.count || compareCorpusRefusalText(left.payload, right.payload)),
      };
    })
    .sort(
      (left, right) =>
        right.blockedDependents - left.blockedDependents ||
        right.directModules - left.directModules ||
        compareCorpusRefusalText(left.family, right.family),
    );

  return {
    directRefusals: direct.length,
    distinctRules: new Set(direct.map((refusal) => parseReadinessRefusalRule(refusal.reason))).size,
    families,
    propagatedRefusals: ledger.refusals.length - direct.length,
    singletonFamilies: families.filter((family) => family.directModules === 1).length,
  };
}

// The rule with its payload removed. An unmatched rule is its own family.
export function getCorpusRefusalFamily(rule: string): string {
  for (const entry of corpusRefusalFamilyPatterns) {
    const match = entry.pattern.exec(rule);
    if (!match) continue;
    // A function replacer keeps `$&` and friends in the *family* text from being reinterpreted.
    return entry.family.replaceAll(/\$(\d+)/gu, (reference, group: string) => match[Number(group)] ?? reference);
  }
  return rule;
}

// What the rule's variable part actually said: the missing symbol list, the property name, the
// emitted type text. This is the part that tells a reader which concrete gap to close next, and it
// is deliberately kept beside the family rather than folded into it.
export function getCorpusRefusalFamilyPayload(rule: string): string | undefined {
  for (const entry of corpusRefusalFamilyPatterns) {
    const match = entry.pattern.exec(rule);
    if (match) return match[entry.payloadGroup];
  }
  return undefined;
}

export function getCorpusRefusalModuleKey(refusal: Readonly<CorpusRefusalRecord>): string {
  return `${refusal.package}/${refusal.module}`;
}

// "dependency <specifier> was refused for <package>/<source>" — the trailing identity is the module
// that refused, and the record's own identity is the module it blocked. Splitting on the last
// marker keeps a specifier that contains the words from truncating the target.
function getCorpusRefusalPropagationTarget(reason: string): string | undefined {
  const marker = reason.lastIndexOf(corpusRefusalDependencyMarker);
  if (marker < 0) return undefined;
  const target = reason.slice(marker + corpusRefusalDependencyMarker.length).trim();
  return target.length === 0 ? undefined : target;
}

// Every module transitively blocked behind one refused module.
//
// One caveat the caller must state rather than hide: the compiler records a single
// `dependency-refused` edge per blocked module, so the edge set is a forest and this walk returns a
// lower bound on the true fan-out. A module blocked by five refused dependencies is counted once,
// against whichever edge the propagation fixed point reached first.
function collectCorpusRefusalBlockedModules(
  module: string,
  dependentsByRefusedModule: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const blocked = new Set<string>();
  const pending = [...(dependentsByRefusedModule.get(module) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || blocked.has(next)) continue;
    blocked.add(next);
    for (const dependent of dependentsByRefusedModule.get(next) ?? []) {
      if (!blocked.has(dependent)) pending.push(dependent);
    }
  }
  return blocked;
}

function compareCorpusRefusalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

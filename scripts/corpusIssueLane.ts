// Which side owns a corpus issue: the compiler, or the runtime the emitted program targets.
//
// The distinction decides who does the work. A message that says a construct has no lowering is the
// compiler's; one that says the emitted program needs a capability the runtime contract does not
// provide is `flight-cpp`'s, and no amount of emitter work will move it.
//
// Patterns are NOUN PHRASES rather than whole clauses, because these messages are not uniform in their
// verb: `typeOf types require ...` sits beside `X requires ...`. A pattern carrying the verb silently
// filed 139 of 305 issues as unclassified before that was fixed, so the phrasing here is deliberate.
//
// This is a heuristic over message text, not a fact the compiler reports. It is ordered and first match
// wins, and correcting it is a matter of editing a row.

export type CorpusIssueLane = 'compiler-emission' | 'compiler-evidence' | 'runtime' | 'unclassified';

// The lanes in the order they are tested.
export const corpusIssueLanes = [
  {
    description: 'the lowering never recorded what the construct means',
    lane: 'compiler-evidence',
    patterns: [
      'expression type evidence',
      'closed runtime type evidence',
      'one runtime value domain',
      'dual-sentinel union evidence',
      'callable result evidence',
      'closed key evidence',
      'concrete value evidence',
      'one value domain',
      'presence projection lowering',
      'presence-aware C++ narrowing',
    ],
  },
  {
    description: 'the emitted program needs something the runtime contract does not provide',
    lane: 'runtime',
    patterns: [
      'runtime external symbol binding plan is incomplete',
      'has no C++ binding',
      'proven C++ representation',
      'external weak-key policy',
      'Unicode code-point iteration runtime contract',
      'runtime contract',
      'is outside the dense flight-cpp array profile',
    ],
  },
  {
    description: 'the meaning is known and the emitter has no form for it',
    lane: 'compiler-emission',
    patterns: [
      'C++ type computation lowering',
      'C++ multiple-inheritance lowering',
      'ordered entry lowering',
      'target-specific accessor lowering',
      'shared C++ reference representation',
      'explicit named properties',
      'represented object-reference target',
      'represented runtime domain',
      'equivalent source union evidence',
      'distinct runtime domains erased',
      'must identify exactly one C++',
      'must identify one C++',
      'statically resolvable C++ object shape',
      'proven union member access',
      'closed callable-object target',
      'requires contextual element type',
      'contextual element type in C++ emission',
      'lowering pass',
    ],
  },
] as const satisfies readonly Readonly<{
  description: string;
  lane: CorpusIssueLane;
  patterns: readonly string[];
}>[];

export function classifyCorpusIssueLane(message: string): CorpusIssueLane {
  for (const { lane, patterns } of corpusIssueLanes) {
    if (patterns.some((pattern) => message.includes(pattern))) return lane;
  }
  // A representation the plan refused. Which side owns it depends on whether the runtime has a form for
  // the type at all, and that cannot be read off the message, so it is reported rather than guessed at.
  return 'unclassified';
}

export function describeCorpusIssueLane(lane: CorpusIssueLane): string {
  return corpusIssueLanes.find((entry) => entry.lane === lane)?.description ?? 'ownership is not determined';
}

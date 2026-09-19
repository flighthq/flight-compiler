import { describe, expect, it } from 'vitest';

import {
  collectCorpusFoundations,
  collectCorpusIssueGroups,
  collectCorpusIssueLaneTotals,
  createCorpusIssueFingerprint,
  isCorpusFoundationRecord,
  isCorpusRefusalCascade,
  normalizeCorpusIssueMessage,
} from './corpusIssueAnalysis.js';

const record = (module: string, packageName: string, reason: string) => ({
  code: 'unsupported-ir',
  module,
  package: packageName,
  reason,
  stage: 'emission',
});

describe('isCorpusRefusalCascade', () => {
  it('recognizes a module that only inherits a dependency refusal', () => {
    expect(isCorpusRefusalCascade('dependency ./abcFile was refused for @flighthq/abc/packages/abc/src/a.ts')).toBe(
      true,
    );
  });

  it('does not mistake a real refusal for a cascade', () => {
    expect(
      isCorpusRefusalCascade(
        'cpp emission failed for @flighthq/types/packages/types/src/Tray.ts: intersection types require C++ lowering',
      ),
    ).toBe(false);
  });
});

describe('normalizeCorpusIssueMessage', () => {
  it('drops the ledger identity prefix and the per-site position', () => {
    const first = normalizeCorpusIssueMessage(
      'cpp emission failed for @flighthq/a/packages/a/src/one.ts: no shape for X',
    );
    const second = normalizeCorpusIssueMessage(
      'cpp emission failed for @flighthq/b/packages/b/src/two.ts: no shape for X',
    );

    expect(first).toBe(second);
    expect(first).toBe('no shape for X');
  });

  it('drops a generated struct name and a count', () => {
    expect(normalizeCorpusIssueMessage('union has 12 domains erased by flight::Ref<abc0123456789def>')).toBe(
      'union has <n> domains erased by flight::Ref<<hash>>',
    );
  });

  // The member named in a diagnostic is the job. Collapsing quoted text would merge `to_lower_case` into
  // every other missing member and report one issue where there are many.
  it('keeps a quoted member name, because the name is the difference', () => {
    const lowered = normalizeCorpusIssueMessage(
      "cpp emission failed for pkg/src/a.ts: 'class flight::String' has no member named 'to_lower_case'",
    );
    const trimmed = normalizeCorpusIssueMessage(
      "cpp emission failed for pkg/src/a.ts: 'const class std::optional<flight::String>' has no member named 'trim'",
    );

    expect(lowered).toContain('to_lower_case');
    expect(lowered).not.toBe(trimmed);
  });
});

describe('collectCorpusIssueGroups', () => {
  const message = 'cpp emission failed for @flighthq/a/packages/a/src/a.ts: one shape is missing';

  it('groups the same issue from two modules as one', () => {
    const groups = collectCorpusIssueGroups([
      { identity: 'packages/a/src/a.ts:1', message },
      { identity: 'packages/b/src/b.ts:2', message: message.replace('/a/', '/b/') },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrences).toBe(2);
    expect(groups[0]?.identities).toEqual(['packages/a/src/a.ts:1', 'packages/b/src/b.ts:2']);
  });

  it('ranks by occurrences, so the expensive issue is first', () => {
    const groups = collectCorpusIssueGroups([
      { identity: 'x:1', message: 'cpp emission failed for a: rare' },
      { identity: 'y:1', message: 'cpp emission failed for a: common' },
      { identity: 'z:1', message: 'cpp emission failed for a: common' },
    ]);

    expect(groups[0]?.key).toBe('common');
    expect(groups[0]?.occurrences).toBe(2);
  });
});

describe('createCorpusIssueFingerprint', () => {
  const groupsFor = (messages: readonly string[]) =>
    collectCorpusIssueGroups(messages.map((message, index) => ({ identity: `${String(index)}:1`, message })));

  it('does not change when occurrences move but the set of issues does not', () => {
    const before = groupsFor(['cpp emission failed for a: one', 'cpp emission failed for b: two']);
    const after = groupsFor([
      'cpp emission failed for a: one',
      'cpp emission failed for c: two',
      'cpp emission failed for d: two',
    ]);

    expect(createCorpusIssueFingerprint(before)).toBe(createCorpusIssueFingerprint(after));
  });

  // This is the case the module counters cannot see: one refusal is replaced by a different one, so the
  // totals hold and the work has still moved.
  it('changes when one issue is replaced by another', () => {
    const before = groupsFor(['cpp emission failed for a: one']);
    const after = groupsFor(['cpp emission failed for a: two']);

    expect(createCorpusIssueFingerprint(before)).not.toBe(createCorpusIssueFingerprint(after));
  });
});

describe('collectCorpusIssueLaneTotals', () => {
  it('counts issues and occurrences per lane', () => {
    const groups = collectCorpusIssueGroups([
      { identity: 'a:1', message: 'cpp emission failed for a: requires expression type evidence' },
      { identity: 'b:1', message: 'cpp emission failed for b: requires expression type evidence' },
      { identity: 'c:1', message: 'cpp emission failed for c: has no C++ binding' },
    ]);
    const totals = collectCorpusIssueLaneTotals(groups);

    expect(totals[0]).toEqual({ issues: 1, lane: 'compiler-evidence', occurrences: 2 });
    expect(totals.find((total) => total.lane === 'runtime')).toEqual({
      issues: 1,
      lane: 'runtime',
      occurrences: 1,
    });
  });
});

describe('isCorpusFoundationRecord', () => {
  it('matches a package identity exactly', () => {
    expect(
      isCorpusFoundationRecord(record('packages/entity/src/a.ts', '@flighthq/entity', 'x'), '@flighthq/entity'),
    ).toBe(true);
    expect(isCorpusFoundationRecord(record('packages/node/src/a.ts', '@flighthq/node', 'x'), '@flighthq/entity')).toBe(
      false,
    );
  });

  it('matches a source path suffix for a module identity', () => {
    expect(
      isCorpusFoundationRecord(record('packages/types/src/Entity.ts', '@flighthq/types', 'x'), 'src/Entity.ts'),
    ).toBe(true);
    expect(
      isCorpusFoundationRecord(record('packages/types/src/Node.ts', '@flighthq/types', 'x'), 'src/Entity.ts'),
    ).toBe(false);
  });
});

describe('collectCorpusFoundations', () => {
  const packages = [
    { emittedModules: 3, package: '@flighthq/entity', refusedModules: 1, sourceModules: 4 },
    { emittedModules: 10, package: '@flighthq/math', refusedModules: 0, sourceModules: 10 },
  ];

  it('reports a foundational package on its own line, cascades excluded', () => {
    const report = collectCorpusFoundations(
      packages,
      [
        record('packages/entity/src/a.ts', '@flighthq/entity', 'cpp emission failed for a: has no C++ binding'),
        record('packages/entity/src/b.ts', '@flighthq/entity', 'dependency ./a was refused for b.ts'),
      ],
      ['@flighthq/entity'],
    );

    expect(report).toHaveLength(1);
    expect(report[0]?.sourceModules).toBe(4);
    expect(report[0]?.refusedModules).toBe(1);
    expect(report[0]?.issues).toHaveLength(1);
    expect(report[0]?.issues[0]?.key).toBe('has no C++ binding');
  });

  it('reports a foundation with no issues as zero rather than omitting it', () => {
    const report = collectCorpusFoundations(packages, [], ['@flighthq/math']);
    expect(report[0]?.identity).toBe('@flighthq/math');
    expect(report[0]?.issues).toEqual([]);
  });
});

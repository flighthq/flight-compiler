import { describe, expect, it } from 'vitest';

import { collectReadinessRuleCounts, parseReadinessRefusalRule } from './readinessRuleGrouping.js';

describe('parseReadinessRefusalRule', () => {
  it('drops the module identity so the same rule from two modules groups as one', () => {
    const first = parseReadinessRefusalRule(
      'rust emission failed for @flighthq/golden/packages/golden/src/a.ts: undefined expressions require Rust Option-aware lowering',
    );
    const second = parseReadinessRefusalRule(
      'rust emission failed for @flighthq/golden/packages/golden/src/b.ts: undefined expressions require Rust Option-aware lowering',
    );

    expect(first).toBe('undefined expressions require Rust Option-aware lowering');
    expect(first).toBe(second);
  });

  it('returns a message with no identity prefix unchanged, and trims', () => {
    expect(parseReadinessRefusalRule('  spread expressions require call lowering  ')).toBe(
      'spread expressions require call lowering',
    );
  });

  it('splits on the first separator so a rule containing a colon keeps its tail', () => {
    expect(
      parseReadinessRefusalRule('rust emission failed for pkg/src/a.ts: binding plan is incomplete (missing: Date)'),
    ).toBe('binding plan is incomplete (missing: Date)');
  });
});

describe('collectReadinessRuleCounts', () => {
  it('ranks by blocked fixtures, then target, then rule, and ignores everything that emitted', () => {
    const counts = collectReadinessRuleCounts([
      { fixture: 'b', rule: 'shared rule', target: 'rust', verdict: 'refused' },
      { fixture: 'a', rule: 'shared rule', target: 'rust', verdict: 'refused' },
      { fixture: 'c', rule: 'zeta rule', target: 'haxe', verdict: 'refused' },
      { fixture: 'd', rule: 'alpha rule', target: 'haxe', verdict: 'refused' },
      { fixture: 'e', rule: 'never counted', target: 'rust', verdict: 'emitted' },
      { fixture: 'f', target: 'rust', verdict: 'refused' },
    ]);

    expect(counts).toEqual([
      { fixtures: ['a', 'b'], rule: 'shared rule', target: 'rust' },
      { fixtures: ['d'], rule: 'alpha rule', target: 'haxe' },
      { fixtures: ['c'], rule: 'zeta rule', target: 'haxe' },
    ]);
  });

  it('orders identically whatever order the outcomes arrive in', () => {
    const outcomes = [
      { fixture: 'a', rule: 'one', target: 'haxe', verdict: 'refused' as const },
      { fixture: 'b', rule: 'two', target: 'haxe', verdict: 'refused' as const },
      { fixture: 'c', rule: 'two', target: 'rust', verdict: 'refused' as const },
    ];

    expect(collectReadinessRuleCounts(outcomes)).toEqual(collectReadinessRuleCounts([...outcomes].reverse()));
  });

  it('reports nothing for a corpus that refuses nothing', () => {
    expect(collectReadinessRuleCounts([{ fixture: 'a', target: 'haxe', verdict: 'emitted' }])).toEqual([]);
  });
});

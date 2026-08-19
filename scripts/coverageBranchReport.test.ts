import { describe, expect, it } from 'vitest';

import { collectUnreachedArms } from './coverageBranchReport.js';
import type { CoverageFileEntry } from './coverageBranchReport.js';

function entry(overrides: CoverageFileEntry): Record<string, CoverageFileEntry> {
  return {
    '/repo/packages/compiler-patch/src/subject.ts': {
      path: '/repo/packages/compiler-patch/src/subject.ts',
      ...overrides,
    },
  };
}

describe('collectUnreachedArms', () => {
  it('reports a branch arm that no test took', () => {
    const coverage = entry({
      b: { '0': [3, 0] },
      branchMap: { '0': { locations: [{ start: { column: 2, line: 10 } }, { start: { column: 9, line: 11 } }] } },
    });

    expect(collectUnreachedArms(coverage)).toEqual([
      { kind: 'branch', line: 11, path: '/repo/packages/compiler-patch/src/subject.ts' },
    ]);
  });

  it('reports nothing when every arm was taken', () => {
    const coverage = entry({
      b: { '0': [1, 2] },
      branchMap: { '0': { locations: [{ start: { line: 10 } }, { start: { line: 11 } }] } },
      s: { '0': 4 },
      statementMap: { '0': { start: { line: 12 } } },
    });

    expect(collectUnreachedArms(coverage)).toEqual([]);
  });

  it('reports an unexecuted statement', () => {
    const coverage = entry({ s: { '0': 0 }, statementMap: { '0': { start: { line: 7 } } } });

    expect(collectUnreachedArms(coverage)).toEqual([
      { kind: 'statement', line: 7, path: '/repo/packages/compiler-patch/src/subject.ts' },
    ]);
  });

  it('falls back to the map key when an entry carries no path', () => {
    const coverage = { '/repo/a.ts': { s: { '0': 0 }, statementMap: { '0': { start: { line: 1 } } } } };

    expect(collectUnreachedArms(coverage).map((arm) => arm.path)).toEqual(['/repo/a.ts']);
  });

  it('sorts by path, then line, then kind', () => {
    const coverage = {
      '/repo/b.ts': { path: '/repo/b.ts', s: { '0': 0 }, statementMap: { '0': { start: { line: 1 } } } },
      '/repo/a.ts': {
        b: { '0': [0] },
        branchMap: { '0': { locations: [{ start: { line: 9 } }] } },
        path: '/repo/a.ts',
        s: { '0': 0 },
        statementMap: { '0': { start: { line: 2 } } },
      },
    };

    expect(collectUnreachedArms(coverage).map((arm) => `${arm.path}:${String(arm.line)}:${arm.kind}`)).toEqual([
      '/repo/a.ts:2:statement',
      '/repo/a.ts:9:branch',
      '/repo/b.ts:1:statement',
    ]);
  });

  it('collapses a location reported by both maps into one entry per kind', () => {
    const coverage = entry({
      b: { '0': [0], '1': [0] },
      branchMap: {
        '0': { locations: [{ start: { line: 5 } }] },
        '1': { locations: [{ start: { line: 5 } }] },
      },
    });

    expect(collectUnreachedArms(coverage)).toHaveLength(1);
  });

  it('ignores an arm whose map carries no line', () => {
    const coverage = entry({ b: { '0': [0] }, branchMap: { '0': { locations: [{ start: {} }] } } });

    expect(collectUnreachedArms(coverage)).toEqual([]);
  });

  it('returns nothing for coverage that measured no files', () => {
    expect(collectUnreachedArms({})).toEqual([]);
  });
});

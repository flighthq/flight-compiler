import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { applyMutant, collectMutants } from './mutationOperators.js';
import type { Mutant } from './mutationOperators.js';

function parse(contents: string): ts.SourceFile {
  return ts.createSourceFile('/probe.ts', contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function descriptions(contents: string): string[] {
  return collectMutants(parse(contents)).map((mutant) => `${mutant.operator}:${mutant.description}`);
}

describe('collectMutants', () => {
  it('substitutes comparison and logical operators', () => {
    expect(descriptions('const a = x < y;')).toEqual(['binary-operator:< -> <=']);
    expect(descriptions('const a = x >= y;')).toEqual(['binary-operator:>= -> >']);
    expect(descriptions('const a = p && q;')).toEqual(['binary-operator:&& -> ||']);
    expect(descriptions('const a = p === q;')).toEqual(['binary-operator:=== -> !==']);
  });

  it('flips boolean literals in both directions', () => {
    expect(descriptions('const a = true;')).toEqual(['boolean-literal:true -> false']);
    expect(descriptions('const a = false;')).toEqual(['boolean-literal:false -> true']);
  });

  it('removes a negation while keeping its operand', () => {
    const mutants = collectMutants(parse('const a = !ready;'));

    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.operator).toBe('negation');
    expect(applyMutant('const a = !ready;', mutants[0]!)).toBe('const a = ready;');
  });

  it('never mutates an operator that only appears inside a string or comment', () => {
    expect(descriptions('// a && b\nconst a = "x === y";')).toEqual([]);
  });

  it('leaves operators with no meaningful substitution alone', () => {
    expect(descriptions('const a = x ?? y;')).toEqual([]);
    expect(descriptions('const a = x * y;')).toEqual([]);
  });

  it('reports mutants in source order with one-based lines', () => {
    const mutants = collectMutants(parse(['const a = p && q;', 'const b = x < y;'].join('\n')));

    expect(mutants.map((mutant) => mutant.line)).toEqual([1, 2]);
  });

  it('finds every mutable site in a compound expression, ordered by source position', () => {
    expect(descriptions('const a = x < y && p === q;')).toEqual([
      'binary-operator:< -> <=',
      'binary-operator:&& -> ||',
      'binary-operator:=== -> !==',
    ]);
  });
});

describe('applyMutant', () => {
  it('rewrites exactly the recorded span', () => {
    const source = 'const a = x < y;';
    const mutant = collectMutants(parse(source))[0]!;

    expect(applyMutant(source, mutant)).toBe('const a = x <= y;');
  });

  it('refuses a substitution that would not change the source', () => {
    const inert: Mutant = {
      description: 'inert',
      end: 3,
      line: 1,
      operator: 'binary-operator',
      replacement: 'abc',
      start: 0,
    };

    expect(() => applyMutant('abcdef', inert)).toThrow('did not change the source');
  });
});

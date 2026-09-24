import { describe, expect, it } from 'vitest';

import { getSourceCompileTargets, parseSourceCompileFilters } from './sourceCompileFilters.js';

describe('parseSourceCompileFilters', () => {
  // The default is deliberately every target: a person running the lane by hand wants the whole
  // corpus, and a CI job is the case that names one target explicitly.
  it('selects every target when no target is named', () => {
    const filters = parseSourceCompileFilters([]);

    expect(getSourceCompileTargets(filters)).toEqual(['cpp', 'haxe', 'rust']);
  });

  it('selects exactly the targets it is given, in either spelling', () => {
    expect(getSourceCompileTargets(parseSourceCompileFilters(['--target', 'cpp']))).toEqual(['cpp']);
    expect(getSourceCompileTargets(parseSourceCompileFilters(['--target=haxe']))).toEqual(['haxe']);
    expect(getSourceCompileTargets(parseSourceCompileFilters(['--target', 'rust', '--target', 'cpp']))).toEqual([
      'cpp',
      'rust',
    ]);
    // A repeated target is a set, not a list: naming one twice compiles it once.
    expect(getSourceCompileTargets(parseSourceCompileFilters(['--target', 'cpp', '--target', 'cpp']))).toEqual(['cpp']);
  });

  it('refuses an unknown target rather than ignoring it', () => {
    expect(() => parseSourceCompileFilters(['--target', 'swift'])).toThrow('Unknown emitted-source target: swift');
    expect(() => parseSourceCompileFilters(['--target=swift'])).toThrow('Unknown emitted-source target: swift');
  });

  it('refuses an unknown argument and a target with no value', () => {
    expect(() => parseSourceCompileFilters(['--fixture', 'typedArraySemantics'])).toThrow(
      'Unknown emitted-source argument: --fixture',
    );
    expect(() => parseSourceCompileFilters(['--target'])).toThrow('--target requires a value');
    expect(() => parseSourceCompileFilters(['--target='])).toThrow('--target= requires a value');
  });
});

describe('getSourceCompileTargets', () => {
  it('orders the selection so a report reads the same however the arguments were given', () => {
    expect(getSourceCompileTargets(parseSourceCompileFilters(['--target', 'rust', '--target', 'haxe']))).toEqual([
      'haxe',
      'rust',
    ]);
  });
});

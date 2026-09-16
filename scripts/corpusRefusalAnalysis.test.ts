import { describe, expect, it } from 'vitest';

import {
  analyzeCorpusRefusals,
  getCorpusRefusalFamily,
  getCorpusRefusalFamilyPayload,
  getCorpusRefusalModuleKey,
} from './corpusRefusalAnalysis.js';

const prefix = 'cpp emission failed for ';

function direct(packageName: string, module: string, rule: string) {
  return {
    code: 'unsupported-ir',
    module,
    package: packageName,
    reason: `${prefix}${packageName}/packages/${packageName}/src/${module}.ts: ${rule}`,
    stage: 'emission',
  };
}

function propagated(packageName: string, module: string, refused: string, specifier = './dependency.js') {
  return {
    code: 'dependency-refused',
    module,
    package: packageName,
    reason: `dependency ${specifier} was refused for ${refused}`,
    stage: 'dependency',
  };
}

function ledger(refusals: readonly Readonly<ReturnType<typeof direct>>[]) {
  return {
    compilerRevision: 'abc1234',
    refusals,
    schema: 'flight-generated-sdk-refusals/2',
    sourceRevision: 'def5678',
  };
}

describe('analyzeCorpusRefusals', () => {
  it('groups two modules refused by one parameterized rule into a single family', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct(
          '@flighthq/a',
          'alpha',
          'runtime external symbol binding plan is incomplete (missing: SharedArrayBuffer[type])',
        ),
        direct(
          '@flighthq/b',
          'beta',
          'runtime external symbol binding plan is incomplete (missing: MapIterator[type])',
        ),
      ]),
    );

    expect(analysis.families).toHaveLength(1);
    expect(analysis.families[0]?.directModules).toBe(2);
    expect(analysis.distinctRules).toBe(2);
  });

  it('keeps a missing binding and a duplicate binding as different families', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct('@flighthq/a', 'alpha', 'runtime external symbol binding plan is incomplete (missing: Map[type])'),
        direct('@flighthq/a', 'beta', 'runtime external symbol binding plan is incomplete (duplicate: Map[type])'),
      ]),
    );

    expect(analysis.families.map((family) => family.family)).toEqual([
      'runtime external symbol binding plan is incomplete (duplicate: <external symbol>)',
      'runtime external symbol binding plan is incomplete (missing: <external symbol>)',
    ]);
  });

  it('keeps an unparameterized rule that resembles a family head as its own family', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct('@flighthq/a', 'alpha', 'runtime external symbol binding plan is incomplete (missing: Map[type])'),
        direct('@flighthq/a', 'beta', 'runtime external symbol binding plan is incomplete'),
      ]),
    );

    expect(analysis.families.map((family) => family.family).sort()).toEqual([
      'runtime external symbol binding plan is incomplete',
      'runtime external symbol binding plan is incomplete (missing: <external symbol>)',
    ]);
  });

  it('counts transitive dependents blocked behind one refused module', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct('@flighthq/a', 'alpha', 'typeOf types require C++ type computation lowering'),
        propagated('@flighthq/a', 'bravo', '@flighthq/a/alpha'),
        propagated('@flighthq/a', 'charlie', '@flighthq/a/bravo'),
        propagated('@flighthq/b', 'delta', '@flighthq/a/charlie'),
      ]),
    );

    expect(analysis.families[0]?.blockedDependents).toBe(3);
    expect(analysis.directRefusals).toBe(1);
    expect(analysis.propagatedRefusals).toBe(3);
  });

  it('counts a module blocked through two paths once', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct('@flighthq/a', 'alpha', 'typeOf types require C++ type computation lowering'),
        propagated('@flighthq/a', 'bravo', '@flighthq/a/alpha'),
        propagated('@flighthq/a', 'charlie', '@flighthq/a/alpha'),
        propagated('@flighthq/a', 'echo', '@flighthq/a/bravo'),
        propagated('@flighthq/a', 'echo', '@flighthq/a/charlie', './other.js'),
      ]),
    );

    expect(analysis.families[0]?.blockedDependents).toBe(3);
  });

  it('adds no edge for a propagation record that names no refused module', () => {
    const analysis = analyzeCorpusRefusals(
      ledger([
        direct('@flighthq/a', 'alpha', 'typeOf types require C++ type computation lowering'),
        {
          code: 'dependency-refused',
          module: 'bravo',
          package: '@flighthq/a',
          reason: 'dependency refused',
          stage: 'dependency',
        },
      ]),
    );

    expect(analysis.families[0]?.blockedDependents).toBe(0);
    expect(analysis.propagatedRefusals).toBe(1);
  });

  it('reports an empty corpus as empty rather than absent', () => {
    const analysis = analyzeCorpusRefusals(ledger([]));

    expect(analysis.families).toEqual([]);
    expect(analysis.directRefusals).toBe(0);
    expect(analysis.singletonFamilies).toBe(0);
  });

  it('orders families, modules, and payloads deterministically from reordered input', () => {
    const records = [
      direct('@flighthq/a', 'alpha', 'runtime external symbol binding plan is incomplete (missing: Map[type])'),
      direct('@flighthq/a', 'bravo', 'runtime external symbol binding plan is incomplete (missing: Set[type])'),
      direct('@flighthq/a', 'charlie', 'typeOf types require C++ type computation lowering'),
    ];
    const forwards = analyzeCorpusRefusals(ledger(records));
    const backwards = analyzeCorpusRefusals(ledger([...records].reverse()));

    expect(backwards.families).toEqual(forwards.families);
    expect(forwards.families[0]?.payloads.map((payload) => payload.payload)).toEqual(['Map[type]', 'Set[type]']);
  });
});

describe('getCorpusRefusalFamily', () => {
  it('replaces the missing-symbol list so two symbol sets read as one family', () => {
    expect(
      getCorpusRefusalFamily(
        'runtime external symbol binding plan is incomplete (missing: WebGLTexture[type], WebGLProgram[type])',
      ),
    ).toBe('runtime external symbol binding plan is incomplete (missing: <external symbol>)');
  });

  it('replaces an anonymous object property name but leaves the rule around it intact', () => {
    expect(
      getCorpusRefusalFamily('anonymous object property lifetime_seconds requires concrete C++ type evidence'),
    ).toBe('anonymous object property <property> requires concrete C++ type evidence');
  });

  it('returns an unrecognized rule unchanged so a new rule surfaces on its own', () => {
    expect(getCorpusRefusalFamily('intersection types require C++ multiple-inheritance lowering')).toBe(
      'intersection types require C++ multiple-inheritance lowering',
    );
  });

  it('does not merge a rule that only starts like a family head', () => {
    expect(getCorpusRefusalFamily('anonymous object property lifetime_seconds requires a represented target')).toBe(
      'anonymous object property lifetime_seconds requires a represented target',
    );
  });

  it('merges two union members whose property names differ', () => {
    const first = getCorpusRefusalFamily('property fovY on a C++ variant requires proven union member access');
    const second = getCorpusRefusalFamily('property socket on a C++ variant requires proven union member access');

    expect(first).toBe('property <property> on a C++ variant requires proven union member access');
    expect(first).toBe(second);
  });

  it('keeps a nested lowering failure as one family across the modules that hit it', () => {
    const first = getCorpusRefusalFamily(
      'Compiler lowering pass catch-await-hoisting failed for @flighthq/loader/packages/loader/src/a.ts: a referenced catch binding cannot cross an await',
    );
    const second = getCorpusRefusalFamily(
      'Compiler lowering pass catch-await-hoisting failed for @flighthq/loader/packages/loader/src/b.ts: a referenced catch binding cannot cross an await',
    );

    expect(first).toBe(
      'Compiler lowering pass catch-await-hoisting failed: a referenced catch binding cannot cross an await',
    );
    expect(first).toBe(second);
  });

  it('keeps two different lowering passes apart even when the detail matches', () => {
    const hoisting = getCorpusRefusalFamily(
      'Compiler lowering pass catch-await-hoisting failed for @flighthq/a/packages/a/src/a.ts: cannot be structurally resolved',
    );
    const inheritance = getCorpusRefusalFamily(
      'Compiler lowering pass interface-inheritance failed for @flighthq/a/packages/a/src/a.ts: cannot be structurally resolved',
    );

    expect(hoisting).not.toBe(inheritance);
  });

  it('keeps two imported-type failure kinds apart while hiding only the type name', () => {
    expect(getCorpusRefusalFamily('imported type CaptureBaseline has unsupportedAmbientReference')).toBe(
      'imported type <type> has unsupportedAmbientReference',
    );
    expect(getCorpusRefusalFamily('imported type PartialNode has indeterminateIdentity')).toBe(
      'imported type <type> has indeterminateIdentity',
    );
  });
});

describe('getCorpusRefusalFamilyPayload', () => {
  it('extracts the symbol list a missing-binding family varies by', () => {
    expect(
      getCorpusRefusalFamilyPayload(
        'runtime external symbol binding plan is incomplete (missing: CPU[type], GPU[type])',
      ),
    ).toBe('CPU[type], GPU[type]');
  });

  it('extracts the emitted type text a placeholder refusal quotes', () => {
    expect(
      getCorpusRefusalFamilyPayload('flight-cpp type position retains unresolved auto placeholder: auto target_ref;'),
    ).toBe('auto target_ref;');
  });

  it('returns nothing for a rule with no variable part', () => {
    expect(getCorpusRefusalFamilyPayload('typeOf types require C++ type computation lowering')).toBeUndefined();
  });

  it('extracts the union member name rather than the whole rule', () => {
    expect(getCorpusRefusalFamilyPayload('property fovY on a C++ variant requires proven union member access')).toBe(
      'fovY',
    );
  });

  it('takes the detail of a nested lowering failure, not the pass the family already names', () => {
    expect(
      getCorpusRefusalFamilyPayload(
        'Compiler lowering pass catch-await-hoisting failed for @flighthq/a/packages/a/src/a.ts: a referenced catch binding cannot cross an await',
      ),
    ).toBe('a referenced catch binding cannot cross an await');
  });
});

describe('getCorpusRefusalModuleKey', () => {
  it('qualifies a module by its package so two packages cannot collide', () => {
    expect(getCorpusRefusalModuleKey(direct('@flighthq/a', 'index', 'rule'))).toBe('@flighthq/a/index');
    expect(getCorpusRefusalModuleKey(direct('@flighthq/b', 'index', 'rule'))).toBe('@flighthq/b/index');
  });
});

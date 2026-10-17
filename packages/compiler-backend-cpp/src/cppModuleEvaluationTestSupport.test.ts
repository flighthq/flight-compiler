import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import { createCppTestModuleEvaluation } from './cppModuleEvaluationTestSupport.js';

describe('createCppTestModuleEvaluation', () => {
  it('uses the canonical empty plan for a session without module links', () => {
    const [module] = lower([{ file: 'value.ts', source: 'export const value = 1;' }]);

    expect(createCppTestModuleEvaluation([module!])).toMatchObject({ entries: [], groups: [], modules: [] });
  });

  it('retains production request order for a closed linked fixture', () => {
    const [alpha, beta, consumer] = lower([
      { file: 'alpha.ts', source: 'export const alpha = 1;' },
      { file: 'beta.ts', source: 'export const beta = 2;' },
      {
        file: 'consumer.ts',
        source:
          "import { beta } from './beta.js'; import { alpha } from './alpha.js'; export const total = beta + alpha;",
      },
    ]);
    const evaluation = createCppTestModuleEvaluation([consumer!, alpha!, beta!]);
    const consumerPlan = evaluation.modules.find((item) => item.module.source.endsWith('/consumer.ts'));

    expect(consumerPlan?.dependencies.map((dependency) => dependency.specifier)).toEqual(['./beta.js', './alpha.js']);
    expect(evaluation.modules).toHaveLength(3);
  });

  it('keeps the maximal closed part of an intentionally unresolved ownership fixture', () => {
    const [provider, consumer] = lower([
      { file: 'provider.ts', source: 'export const value = 1;' },
      {
        file: 'consumer.ts',
        source: "import { missing } from './missing.js'; export const value = missing;",
      },
    ]);
    const evaluation = createCppTestModuleEvaluation([consumer!, provider!]);

    expect(evaluation.entries.map((entry) => entry.source)).toEqual([provider!.source]);
    expect(evaluation.modules.map((item) => item.module.source)).toEqual([provider!.source]);
  });

  it('retains local evaluation for a single-module unresolved ownership fixture', () => {
    const [module] = lower([
      {
        file: 'consumer.ts',
        source: "import { missing } from './missing.js'; export const value = missing;",
      },
    ]);
    const evaluation = createCppTestModuleEvaluation([module!]);

    expect(evaluation.entries).toEqual([
      { name: module!.name, packageName: module!.packageName, source: module!.source },
    ]);
    expect(evaluation.modules.map((item) => item.module)).toEqual(evaluation.entries);
  });
});

function lower(fixtures: readonly Readonly<{ file: string; source: string }>[]) {
  return lowerTypeScriptSources(
    fixtures.map(({ file, source }) => ({
      packageName: '@fixture/evaluation',
      sourceFile: ts.createSourceFile(`/flight/packages/evaluation/src/${file}`, source, ts.ScriptTarget.Latest, true),
      upstreamDirectory: '/flight',
    })),
  ).map((result) => result.module);
}

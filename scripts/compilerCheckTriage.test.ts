import { describe, expect, it } from 'vitest';

import {
  analyzeCompilerCheckTriage,
  getCompilerCheckMissingBindings,
  getCompilerCheckTriageOwner,
  readCompilerCheckTriageReport,
} from './compilerCheckTriage.js';
import type {
  CompilerCheckTriageFindingInput,
  CompilerCheckTriageModule,
  CompilerCheckTriageReportInput,
} from './compilerCheckTriage.js';

const bindingRule = 'cpp-runtime-external-symbol-binding-incomplete';

describe('analyzeCompilerCheckTriage', () => {
  it('ranks identities by fan-out without claiming shared-root cascades are exclusively unlocked', () => {
    const rootA = module_('@flight/a', 'src/root-a.ts', 'RootA');
    const rootB = module_('@flight/b', 'src/root-b.ts', 'RootB');
    const other = module_('@flight/a', 'src/other.ts', 'Other');
    const report = report_(
      [
        missingBindingFinding('binding-a', rootA, ['Blob[type]', 'AbortSignal[type]']),
        missingBindingFinding('binding-b', rootB, ['AbortSignal[type]', 'Blob[type]']),
        finding('compiler-root', other, 'compiler-restriction', 'lowering'),
        finding('second-root-a', rootA, 'compiler-restriction', 'emission'),
        finding('source-root-b', rootB, 'source-portability', 'source'),
      ],
      [
        cascade('@flight/app', 'src/sole.ts', 'Sole', ['binding-a']),
        cascade('@flight/app', 'src/both.ts', 'Both', ['binding-a', 'binding-b']),
        cascade('@flight/app', 'src/shared.ts', 'Shared', ['binding-a', 'compiler-root']),
        cascade('@flight/app', 'src/compiler.ts', 'Compiler', ['compiler-root']),
      ],
    );

    const analysis = analyzeCompilerCheckTriage(report);

    expect(analysis.rankedFindings.slice(0, 3).map(({ cascadeFanOut, identity }) => [identity, cascadeFanOut])).toEqual(
      [
        ['binding-a', 3],
        ['compiler-root', 2],
        ['binding-b', 1],
      ],
    );
    expect(analysis.rankedFindings[0]?.exclusivelyBlockedModules).toEqual(['@flight/app/src/sole.ts#Sole']);
    expect(analysis.missingBindingCandidates).toHaveLength(1);
    expect(analysis.missingBindingCandidates[0]).toMatchObject({
      bindings: ['AbortSignal[type]', 'Blob[type]'],
      cascadeFanOut: 3,
      cascadeModulesUnlocked: ['@flight/app/src/both.ts#Both', '@flight/app/src/sole.ts#Sole'],
      directFindingIdentities: ['binding-a', 'binding-b'],
      directModulesUnlocked: ['@flight/b/src/root-b.ts#RootB'],
      modulesUnlocked: [
        '@flight/app/src/both.ts#Both',
        '@flight/app/src/sole.ts#Sole',
        '@flight/b/src/root-b.ts#RootB',
      ],
      owner: 'runtime',
    });
  });

  it('keeps different complete missing-binding sets as different candidates', () => {
    const module = module_('@flight/a', 'src/root.ts', 'Root');
    const analysis = analyzeCompilerCheckTriage(
      report_(
        [
          missingBindingFinding('abort', module, ['AbortSignal[type]']),
          missingBindingFinding('abort-and-blob', module_('@flight/b', 'src/root.ts', 'Root'), [
            'AbortSignal[type]',
            'Blob[type]',
          ]),
        ],
        [],
      ),
    );

    expect(analysis.missingBindingCandidates.map((candidate) => candidate.bindings)).toEqual([
      ['AbortSignal[type]'],
      ['AbortSignal[type]', 'Blob[type]'],
    ]);
  });

  it('is deterministic when findings and cascades are reordered', () => {
    const first = missingBindingFinding('first', module_('@flight/a', 'src/a.ts', 'A'), ['AbortSignal[type]']);
    const second = missingBindingFinding('second', module_('@flight/b', 'src/b.ts', 'B'), ['AbortSignal[type]']);
    const cascades = [
      cascade('@flight/app', 'src/one.ts', 'One', ['first']),
      cascade('@flight/app', 'src/two.ts', 'Two', ['second']),
    ];

    expect(analyzeCompilerCheckTriage(report_([second, first], [...cascades].reverse()))).toEqual(
      analyzeCompilerCheckTriage(report_([first, second], cascades)),
    );
  });
});

describe('compiler check triage input', () => {
  it('reads a report directly or through a check-run artifact', () => {
    const report = report_([], []);

    expect(readCompilerCheckTriageReport(report)).toBe(report);
    expect(readCompilerCheckTriageReport({ report, schema: 'flight-compiler-check-run/1' })).toBe(report);
    expect(() => readCompilerCheckTriageReport({ schema: 'other' })).toThrow('flight-compiler-check-report/1');
  });

  it('extracts every missing binding and rejects an incomplete occurrence shape', () => {
    const module = module_('@flight/a', 'src/root.ts', 'Root');
    const finding = missingBindingFinding('binding', module, ['Blob[type]', 'AbortSignal[type]']);

    expect(getCompilerCheckMissingBindings(finding)).toEqual(['AbortSignal[type]', 'Blob[type]']);
    expect(
      getCompilerCheckMissingBindings({
        ...finding,
        occurrences: [...finding.occurrences, { message: 'an unrelated occurrence' }],
      }),
    ).toBeUndefined();
  });

  it('maps producer policy classes to planning owners without guessing an unclassified finding', () => {
    expect(getCompilerCheckTriageOwner('target-runtime')).toBe('runtime');
    expect(getCompilerCheckTriageOwner('source-portability')).toBe('upstream');
    expect(getCompilerCheckTriageOwner('compiler-defect')).toBe('compiler');
    expect(getCompilerCheckTriageOwner('compiler-restriction')).toBe('compiler');
    expect(getCompilerCheckTriageOwner('unclassified')).toBe('unassigned');
  });
});

function module_(packageName: string, source: string, name: string): CompilerCheckTriageModule {
  return { name, packageName, source };
}

function finding(
  identity: string,
  module: CompilerCheckTriageModule,
  policyClass: CompilerCheckTriageFindingInput['policyClass'],
  stage: CompilerCheckTriageFindingInput['stage'],
): CompilerCheckTriageFindingInput {
  return {
    code: 'unsupported-ir',
    identity,
    module,
    occurrences: [{ message: identity }],
    policyClass,
    rule: identity,
    stage,
  };
}

function missingBindingFinding(
  identity: string,
  module: CompilerCheckTriageModule,
  bindings: readonly string[],
): CompilerCheckTriageFindingInput {
  return {
    code: 'unsupported-ir',
    identity,
    module,
    occurrences: [
      {
        message: `cpp emission failed for ${module.packageName}/${module.source}: runtime external symbol binding plan is incomplete (missing: ${bindings.join(', ')}) Add exact target bindings without erasure.`,
      },
    ],
    policyClass: 'target-runtime',
    rule: bindingRule,
    stage: 'emission',
  };
}

function cascade(packageName: string, source: string, name: string, directFindingIdentities: readonly string[]) {
  return { directFindingIdentities, module: module_(packageName, source, name) };
}

function report_(
  directFindings: readonly CompilerCheckTriageFindingInput[],
  cascades: CompilerCheckTriageReportInput['cascades'],
): CompilerCheckTriageReportInput {
  return {
    backend: 'cpp',
    cascades,
    directFindings,
    provenance: {
      compiler: { name: 'compiler', revision: 'compiler-revision' },
      target: { name: 'target', revision: 'target-revision' },
      upstream: { name: 'flight', revision: 'flight-revision' },
    },
    schema: 'flight-compiler-check-report/1',
  };
}

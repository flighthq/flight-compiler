import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleFacadePlan,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerRustSourceTreePlan,
  CompilerRustSourceTreePlanningFailureCode,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerRustSourceTreePlan, isCompilerRustSourceTreePlanningFailure } from './rustSourceTreePlan.js';

describe('createCompilerRustSourceTreePlan', () => {
  it('combines root and nested index owners with their child declarations', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const nested = lower('@scope/math', 'geometry/index.ts', 'export const geometry = 1;');
    const line = lower('@scope/math', 'geometry/line.ts', 'export interface Line { length: number }');
    const plan = createPlan([line, root, nested], [root]);
    const rootFile = findFile(plan, '@scope/math', []);
    const nestedFile = findFile(plan, '@scope/math', ['geometry']);

    expect(rootFile).toMatchObject({
      filePath: 'lib.rs',
      ownership: { kind: 'source', module: identity(root) },
      sourceFragment: 'mod geometry;',
    });
    expect(nestedFile).toMatchObject({
      filePath: 'geometry/mod.rs',
      ownership: { kind: 'source', module: identity(nested) },
      sourceFragment: 'mod line;',
    });
    expect(plan.files).toHaveLength(3);
  });

  it('synthesizes missing root and intermediate indexes with descendant provenance', () => {
    const point = lower('@scope/math', 'geometry/shapes/point.ts', 'export interface Point { x: number }');
    const plan = createPlan([point], [point]);

    expect(findFile(plan, '@scope/math', [])).toEqual({
      declarations: [{ modulePath: ['geometry'], name: 'geometry', visibility: 'public' }],
      filePath: 'lib.rs',
      modulePath: [],
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      packageName: '@scope/math',
      sourceFragment: 'pub mod geometry;',
    });
    expect(findFile(plan, '@scope/math', ['geometry'])).toMatchObject({
      filePath: 'geometry/mod.rs',
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      sourceFragment: 'pub mod shapes;',
    });
    expect(findFile(plan, '@scope/math', ['geometry', 'shapes'])).toMatchObject({
      filePath: 'geometry/shapes/mod.rs',
      ownership: { kind: 'skeleton', provenance: [identity(point)] },
      sourceFragment: 'pub mod point;',
    });
    expect(findFile(plan, '@scope/math', ['geometry', 'shapes', 'point'])).toMatchObject({
      filePath: 'geometry/shapes/point.rs',
      ownership: { kind: 'source' },
      sourceFragment: '',
    });
  });

  it('marks only module edges required by actual facade visibility as public', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const publicApi = lower('@scope/math', 'api/contract.ts', 'export const contract = 1;');
    const privateValue = lower('@scope/math', 'internal/value.ts', 'export const value = 1;');
    const plan = createPlan([privateValue, root, publicApi], [publicApi]);

    expect(findFile(plan, '@scope/math', []).sourceFragment).toBe('pub mod api;\nmod internal;');
    expect(findFile(plan, '@scope/math', ['api']).sourceFragment).toBe('pub mod contract;');
    expect(findFile(plan, '@scope/math', ['internal']).sourceFragment).toBe('mod value;');
  });

  it('plans scoped multi-package files and canonical same- and cross-crate references', () => {
    const entry = lower('@alpha/math', 'index.ts', "import { useValue } from './nested/use.js'; export { useValue };");
    const use = lower(
      '@alpha/math',
      'nested/use.ts',
      "import type { Value } from '@beta/types/value'; export function useValue(value: Value): number { return value.size; }",
    );
    const value = lower('@beta/types', 'deep/value.ts', 'export interface Value { size: number }');
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(entry),
          specifier: './nested/use.js',
          target: identity(use),
        },
        {
          importer: identity(use),
          specifier: '@beta/types/value',
          target: identity(value),
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const facade = createFacade([entry]);
    const first = createCompilerRustSourceTreePlan({
      facade,
      moduleResolution: resolution,
      modules: [value, entry, use],
    });
    const second = createCompilerRustSourceTreePlan({
      facade: { ...facade, modules: [...facade.modules].reverse() },
      moduleResolution: { ...resolution, edges: [...resolution.edges].reverse() },
      modules: [use, entry, value],
    });

    expect(second).toEqual(first);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.modules.map((module) => module.filePath)).toEqual([
      'alpha-math/src/lib.rs',
      'alpha-math/src/nested/use_.rs',
      'beta-types/src/deep/value.rs',
    ]);
    expect(first.references.map((reference) => [reference.specifier, reference.rustPath])).toEqual([
      ['./nested/use.js', 'crate::nested::use_'],
      ['@beta/types/value', 'beta_types::deep::value'],
    ]);
    expect(first.files.some((file) => /Cargo\.toml|Cargo\.lock/u.test(file.filePath))).toBe(false);
  });

  it('fails loudly on module, file, crate, public-facade, and import ambiguity', () => {
    const root = lower('@scope/math', 'index.ts', 'export const root = 1;');
    const lib = lower('@scope/math', 'lib.ts', 'export const lib = 1;');
    expectPlanningFailure([root, lib], [root], undefined, 'rust-source-tree-file-collision');

    const file = lower('@scope/math', 'values.ts', 'export const file = 1;');
    const index = lower('@scope/math', 'values/index.ts', 'export const index = 1;');
    expectPlanningFailure([file, index], [file], undefined, 'rust-source-tree-module-collision');

    const firstCrate = lower('@scope-a/model', 'first.ts', 'export const first = 1;');
    const secondCrate = lower('@scope_a/model', 'second.ts', 'export const second = 2;');
    expectPlanningFailure([firstCrate, secondCrate], [firstCrate], undefined, 'rust-source-tree-crate-collision');

    const absentPublicModule = lower('@scope/math', 'absent.ts', 'export const absent = 1;');
    expectPlanningFailure([root], [absentPublicModule], undefined, 'rust-source-tree-public-module-missing');

    const consumer = lower('@scope/math', 'consumer.ts', "import { value } from './value'; export { value };");
    const firstTarget = lower('@scope/math', 'first.ts', 'export const value = 1;');
    const secondTarget = lower('@scope/math', 'second.ts', 'export const value = 2;');
    expectPlanningFailure(
      [consumer, firstTarget, secondTarget],
      [consumer],
      {
        edges: [
          { importer: identity(consumer), specifier: './value', target: identity(firstTarget) },
          { importer: identity(consumer), specifier: './value', target: identity(secondTarget) },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      'rust-source-tree-import-ambiguity',
    );
    expectPlanningFailure(
      [consumer, firstTarget, secondTarget],
      [consumer],
      {
        edges: [
          { importer: identity(consumer), specifier: './value', target: identity(firstTarget) },
          {
            importedNames: ['value'],
            importer: identity(consumer),
            specifier: './value',
            target: identity(secondTarget),
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      'rust-source-tree-import-ambiguity',
    );
    expectPlanningFailure([consumer], [consumer], undefined, 'rust-source-tree-import-ambiguity');
  });

  it('does not mutate caller-owned graph facts', () => {
    const module = lower('@scope/math', 'value.ts', 'export const value = 1;');
    const input = { facade: createFacade([module]), modules: [module] } as const;
    const snapshot = structuredClone(input);

    createCompilerRustSourceTreePlan(input);

    expect(input).toEqual(snapshot);
  });
});

describe('isCompilerRustSourceTreePlanningFailure', () => {
  it('recognizes complete planning failures and rejects lookalikes', () => {
    const failure = Object.assign(new Error('collision'), {
      code: 'rust-source-tree-file-collision',
      kind: 'rust-source-tree-planning',
      subjects: ['first', 'second'],
    });

    expect(isCompilerRustSourceTreePlanningFailure(failure)).toBe(true);
    expect(isCompilerRustSourceTreePlanningFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRustSourceTreePlanningFailure({ ...failure })).toBe(false);
    expect(
      isCompilerRustSourceTreePlanningFailure(Object.assign(new Error('empty'), { ...failure, subjects: [] })),
    ).toBe(false);
    expect(
      isCompilerRustSourceTreePlanningFailure(Object.assign(new Error('unknown'), { ...failure, code: 'unknown' })),
    ).toBe(false);
  });
});

function createFacade(modules: readonly Readonly<IrModule>[]): CompilerModuleFacadePlan {
  return {
    modules: modules.map((module) => ({ module: identity(module), slots: [] })),
    schema: 'flight-compiler-module-facade/1',
    semantics: {
      bindingAccess: 'live',
      explicitPrecedence: 'named-over-star',
      starAmbiguity: 'refuse-distinct-resolutions',
      starDefault: 'excluded',
      typeValueLanes: 'independent',
    },
  };
}

function createPlan(modules: readonly Readonly<IrModule>[], publicModules: readonly Readonly<IrModule>[]) {
  return createCompilerRustSourceTreePlan({ facade: createFacade(publicModules), modules });
}

function expectPlanningFailure(
  modules: readonly Readonly<IrModule>[],
  publicModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  code: CompilerRustSourceTreePlanningFailureCode,
): void {
  let failure: unknown;
  try {
    createCompilerRustSourceTreePlan({
      facade: createFacade(publicModules),
      ...(moduleResolution ? { moduleResolution } : {}),
      modules,
    });
  } catch (error) {
    failure = error;
  }
  expect(isCompilerRustSourceTreePlanningFailure(failure)).toBe(true);
  if (!isCompilerRustSourceTreePlanningFailure(failure)) throw failure;
  expect(failure.code).toBe(code);
}

function findFile(plan: Readonly<CompilerRustSourceTreePlan>, packageName: string, modulePath: readonly string[]) {
  const file = plan.files.find(
    (candidate) =>
      candidate.packageName === packageName &&
      candidate.modulePath.length === modulePath.length &&
      candidate.modulePath.every((segment, index) => segment === modulePath[index]),
  );
  if (!file) throw new Error(`Missing source-tree file ${packageName}/${modulePath.join('/')}`);
  return file;
}

function identity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((item) => isDeeplyFrozen(item, seen));
}

function lower(packageName: string, file: string, source: string): IrModule {
  const packageLeaf = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageLeaf}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = lowerTypeScriptSource(sourceFile, { packageName, upstreamDirectory: '/flight' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
  return result.module;
}

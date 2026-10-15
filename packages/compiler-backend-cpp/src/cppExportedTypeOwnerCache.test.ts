import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, IrModule } from '../../compiler-types/src/index.js';
import { createCppCompilerBackend } from './cppCompilerBackend.js';

describe('C++ exported type owner lookup cache', () => {
  it('reuses a complete recursive barrel lookup within one session', () => {
    const fixture = createBarrelFixture();
    const tracked = trackModuleExportReads(fixture.barrel);
    const modules = fixture.modules.map((module) => (module === fixture.barrel ? tracked.module : module));
    const session = createInstrumentedSession(modules, fixture.moduleResolution);

    tracked.reset();
    const cold = session.emitModule(fixture.consumer)[0]!.contents;
    const coldReads = tracked.reads();
    tracked.reset();
    const warm = session.emitModule(fixture.consumer)[0]!.contents;
    const warmReads = tracked.reads();

    expect(cold).toContain('fixture::types::Alias7');
    expect(warm).toBe(cold);
    expect(coldReads).toBeGreaterThan(0);
    expect(warmReads).toBe(0);
  });

  it('owns the memo per session and remains deterministic when module order changes', () => {
    const fixture = createBarrelFixture();
    const tracked = trackModuleExportReads(fixture.barrel);
    const modules = fixture.modules.map((module) => (module === fixture.barrel ? tracked.module : module));
    const firstSession = createInstrumentedSession(modules, fixture.moduleResolution);

    tracked.reset();
    const first = firstSession.emitModule(fixture.consumer)[0]!.contents;
    const firstReads = tracked.reads();

    const secondSession = createInstrumentedSession(modules, fixture.moduleResolution);
    tracked.reset();
    const second = secondSession.emitModule(fixture.consumer)[0]!.contents;
    const secondReads = tracked.reads();

    const reversed = createSession([...fixture.modules].reverse(), fixture.moduleResolution).emitModule(
      fixture.consumer,
    )[0]!.contents;

    expect(firstReads).toBeGreaterThan(0);
    expect(secondReads).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(reversed).toBe(first);
  });

  it('does not memoize a graph answer truncated by a re-export cycle', () => {
    const fixture = createBarrelFixture({ cycle: true });
    const tracked = trackModuleExportReads(fixture.barrel);
    const modules = fixture.modules.map((module) => (module === fixture.barrel ? tracked.module : module));
    const session = createInstrumentedSession(modules, fixture.moduleResolution);

    tracked.reset();
    const first = session.emitModule(fixture.consumer)[0]!.contents;
    const firstReads = tracked.reads();
    tracked.reset();
    const second = session.emitModule(fixture.consumer)[0]!.contents;
    const secondReads = tracked.reads();

    expect(first).toContain('fixture::types::Alias7');
    expect(second).toBe(first);
    expect(firstReads).toBeGreaterThan(0);
    expect(secondReads).toBeGreaterThan(0);
  });

  it('caches the complete ambiguous owner set without selecting one owner', () => {
    const fixture = createAmbiguousFixture();
    const session = createSession(fixture.modules, fixture.moduleResolution);

    const cold = captureFailure(() => session.emitModule(fixture.consumer));
    const warm = captureFailure(() => session.emitModule(fixture.consumer));

    expect(cold).toMatchObject({ rule: 'cpp-imported-binding-no-export-target' });
    expect(cold.message).toContain('requires one exact exported declaration owner');
    expect(warm).toMatchObject({ message: cold.message, rule: cold.rule });
  });
});

function createBarrelFixture(options: Readonly<{ cycle?: boolean }> = {}): {
  barrel: IrModule;
  consumer: IrModule;
  moduleResolution: CompilerModuleResolutionPlan;
  modules: IrModule[];
} {
  const moduleCount = 16;
  const typeSources = Array.from({ length: moduleCount }, (_, index) =>
    source(
      '@fixture/types',
      `packages/types/src/M${String(index)}.ts`,
      `export interface Owner${String(index)} { value: number }
       export type Alias${String(index)} = Owner${String(index)};`,
    ),
  );
  const cycleSources = options.cycle
    ? [
        source('@fixture/types', 'packages/types/src/CycleA.ts', "export * from './CycleB';"),
        source('@fixture/types', 'packages/types/src/CycleB.ts', "export * from './CycleA';"),
      ]
    : [];
  const barrelSource = source(
    '@fixture/types',
    'packages/types/src/contract.ts',
    `${Array.from({ length: moduleCount }, (_, index) => `export * from './M${String(index)}';`).join('\n')}
     ${options.cycle ? "export * from './CycleA';" : ''}
     export type { Alias7 as Shared } from './M7';`,
  );
  const uses = Array.from(
    { length: 12 },
    (_, index) => `export function retain${String(index)}(value: Shared): Shared { return value; }`,
  ).join('\n');
  const consumerSource = source(
    '@fixture/consumer',
    'packages/consumer/src/use.ts',
    `import type { Shared } from '@fixture/types/contract';
     ${uses}`,
  );
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: [
      ...Array.from({ length: moduleCount }, (_, index) => ({
        specifier: `./M${String(index)}`,
        target: { packageName: '@fixture/types', source: `packages/types/src/M${String(index)}.ts` },
      })),
      ...(options.cycle
        ? [
            {
              specifier: './CycleA',
              target: { packageName: '@fixture/types', source: 'packages/types/src/CycleA.ts' },
            },
            {
              specifier: './CycleB',
              target: { packageName: '@fixture/types', source: 'packages/types/src/CycleB.ts' },
            },
          ]
        : []),
      {
        specifier: '@fixture/types/contract',
        target: { packageName: '@fixture/types', source: 'packages/types/src/contract.ts' },
      },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
  const results = lowerTypeScriptSources(
    [...typeSources, ...cycleSources, barrelSource, consumerSource],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const modules = results.map((result) => result.module);
  const barrelIndex = moduleCount + cycleSources.length;
  return {
    barrel: modules[barrelIndex]!,
    consumer: modules[barrelIndex + 1]!,
    moduleResolution,
    modules,
  };
}

function createAmbiguousFixture(): {
  consumer: IrModule;
  moduleResolution: CompilerModuleResolutionPlan;
  modules: IrModule[];
} {
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: [
      {
        specifier: './A',
        target: { packageName: '@fixture/types', source: 'packages/types/src/A.ts' },
      },
      {
        specifier: './B',
        target: { packageName: '@fixture/types', source: 'packages/types/src/B.ts' },
      },
      {
        specifier: '@fixture/types/contract',
        target: { packageName: '@fixture/types', source: 'packages/types/src/contract.ts' },
      },
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
  const results = lowerTypeScriptSources(
    [
      source('@fixture/types', 'packages/types/src/A.ts', 'export interface Shared { a: number }'),
      source('@fixture/types', 'packages/types/src/B.ts', 'export interface Shared { b: string }'),
      source('@fixture/types', 'packages/types/src/contract.ts', "export * from './A';"),
      source(
        '@fixture/consumer',
        'packages/consumer/src/use.ts',
        `import type { Shared } from '@fixture/types/contract';
         export function retain(value: Shared): Shared { return value; }`,
      ),
    ],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const modules = results.map((result) => result.module);
  modules[2] = {
    ...modules[2]!,
    exports: [...modules[2]!.exports, { kind: 'all', specifier: './B', typeOnly: false }],
  };
  return { consumer: modules[3]!, moduleResolution, modules };
}

function createSession(modules: readonly IrModule[], moduleResolution: CompilerModuleResolutionPlan) {
  return createCppCompilerBackend().createEmissionSession!({
    moduleResolution,
    modules,
    options: {
      packageTargets: {
        '@fixture/consumer': { includePrefix: 'fixture/consumer', namespace: 'fixture::consumer' },
        '@fixture/types': { includePrefix: 'fixture/types', namespace: 'fixture::types' },
      },
      runtimeProfile: 'flight-cpp',
    },
  });
}

function createInstrumentedSession(
  modules: readonly IrModule[],
  moduleResolution: CompilerModuleResolutionPlan,
): ReturnType<typeof createSession> {
  // The reference planner snapshots modules with structuredClone. Keep instrumented identities only while
  // constructing this fixture so its getter observes graph walks; normal sessions still take the real snapshot.
  const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(<T>(value: T): T => value);
  try {
    return createSession(modules, moduleResolution);
  } finally {
    clone.mockRestore();
  }
}

function captureFailure(action: () => unknown): Error & { rule?: string | undefined } {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected C++ exported owner resolution to fail');
}

function trackModuleExportReads(module: IrModule): {
  module: IrModule;
  reads: () => number;
  reset: () => void;
} {
  let reads = 0;
  const exports = module.exports;
  const tracked = { ...module };
  Object.defineProperty(tracked, 'exports', {
    enumerable: true,
    get() {
      reads += 1;
      return exports;
    },
  });
  return {
    module: tracked,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function source(packageName: string, sourcePath: string, text: string) {
  return {
    packageName,
    sourceFile: ts.createSourceFile(`/flight/${sourcePath}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  };
}

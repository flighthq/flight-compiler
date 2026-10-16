import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatHaxeDualBindingGateRunReport,
  getHaxeDualBindingRunSummary,
  runHaxeDualBindingGateChecks,
} from './haxeDualBindingRun.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

// A tiny but complete pair of backings: a real ESM module with a callable and a type, and a real header
// plus slice that declares and defines both. The plans below point at these, so a passing run is one that
// loaded a module and built a program, not one that read two JSON files and believed them.
function createFixtureWorkspace(): {
  readonly artifactDirectory: string;
  readonly cpp: { readonly includeDirectories: readonly string[]; readonly slicePaths: readonly string[] };
  readonly js: { readonly moduleDirectories: readonly string[] };
} {
  const directory = mkdtempSync(path.join(tmpdir(), 'haxe-dual-binding-run-'));
  directories.push(directory);
  const artifactDirectory = path.join(directory, 'plans');
  const sliceDirectory = path.join(directory, 'slice');
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(sliceDirectory, { recursive: true });
  writeFileSync(
    path.join(sliceDirectory, 'tiny.mjs'),
    'export function draw() {}\nexport const Surface = { name: "Surface" };\n',
  );
  writeFileSync(
    path.join(sliceDirectory, 'tiny.hpp'),
    '#pragma once\nnamespace flight::dual {\nstruct Surface { int width = 0; };\nvoid draw(int value);\n}\n',
  );
  writeFileSync(
    path.join(sliceDirectory, 'tiny.cpp'),
    '#include "tiny.hpp"\nnamespace flight::dual { void draw(int value) { (void)value; } }\n',
  );
  return {
    artifactDirectory,
    cpp: { includeDirectories: [sliceDirectory], slicePaths: [path.join(sliceDirectory, 'tiny.cpp')] },
    js: { moduleDirectories: [sliceDirectory] },
  };
}

function callableBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpp: {
      availability: 'available',
      locator: { carrier: 'function', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'draw' },
    },
    identity: {
      declarationIdentity: 'sha256:draw',
      exportRoute: 'flight.render',
      packageName: '@flight/render',
      source: 'packages/render/src/draw.ts',
      space: 'value',
    },
    javascript: { availability: 'available', locator: { exportedName: 'draw', specifier: './tiny.mjs' } },
    key: 'draw',
    publicHaxe: {
      kind: 'function',
      name: 'draw',
      owner: '',
      qualifiedName: 'flight.render.draw',
      signature: 'draw(context, image): void',
      typeIdentity: 'sha256:draw-type',
    },
    ...overrides,
  };
}

function typeBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpp: {
      availability: 'available',
      locator: { carrier: 'interface', include: 'tiny.hpp', namespace: 'flight::dual', spelling: 'Surface' },
    },
    identity: {
      declarationIdentity: 'sha256:surface',
      exportRoute: 'flight.render',
      packageName: '@flight/render',
      source: 'packages/render/src/surface.ts',
      space: 'type',
    },
    javascript: { availability: 'available', locator: { exportedName: 'Surface', specifier: './tiny.mjs' } },
    key: 'surface',
    publicHaxe: {
      kind: 'type',
      name: 'Surface',
      owner: '',
      qualifiedName: 'flight.render.Surface',
      typeIdentity: 'sha256:surface-type',
    },
    ...overrides,
  };
}

function completeArtifact(bindings: readonly Record<string, unknown>[] = [callableBinding(), typeBinding()]) {
  return { bindings, schema: 'flight-haxe-dual-binding-plan/1' };
}

describe('runHaxeDualBindingGateChecks', () => {
  it('verifies a plan whose exports and symbols really exist, and reports the lanes it verified', async () => {
    const workspace = createFixtureWorkspace();
    writeFileSync(
      path.join(workspace.artifactDirectory, 'flight.render.json'),
      JSON.stringify(completeArtifact(), null, 2),
    );

    const report = await runHaxeDualBindingGateChecks({
      artifactDirectory: workspace.artifactDirectory,
      cpp: workspace.cpp,
      js: workspace.js,
    });

    expect(report.failures).toEqual([]);
    expect(report.artifacts).toEqual(['flight.render.json']);
    expect(report.lanes).toEqual([
      { artifact: 'flight.render.json', kind: 'cpp', skipped: [], verified: { callables: 1, types: 1 } },
      { artifact: 'flight.render.json', kind: 'javascript', skipped: [], verified: { callables: 1, types: 1 } },
    ]);
    expect(getHaxeDualBindingRunSummary(report)).toEqual({ callables: 2, failures: 0, types: 2, unchecked: 0 });
  });

  it('reports a non-JSON artifact, a missing export, and a refused backing in one run', async () => {
    const workspace = createFixtureWorkspace();
    writeFileSync(path.join(workspace.artifactDirectory, 'flight.broken-json.json'), '{ this is not json');
    writeFileSync(
      path.join(workspace.artifactDirectory, 'flight.missing-export.json'),
      JSON.stringify(
        completeArtifact([
          callableBinding({
            javascript: { availability: 'available', locator: { exportedName: 'absent', specifier: './tiny.mjs' } },
          }),
        ]),
      ),
    );
    writeFileSync(
      path.join(workspace.artifactDirectory, 'flight.refused.json'),
      JSON.stringify(
        completeArtifact([
          callableBinding({
            cpp: {
              availability: 'refused',
              refusal: {
                code: 'cpp-declaration-missing',
                message: 'no C++ declaration was emitted for this export route',
                subject: 'flight.render.draw',
              },
            },
          }),
          typeBinding(),
        ]),
      ),
    );

    const report = await runHaxeDualBindingGateChecks({
      artifactDirectory: workspace.artifactDirectory,
      cpp: workspace.cpp,
      js: workspace.js,
    });

    expect(report.artifacts).toEqual(['flight.broken-json.json', 'flight.missing-export.json', 'flight.refused.json']);
    expect(report.failures.map((failure) => [failure.artifact, failure.rule, failure.subject])).toEqual([
      ['flight.broken-json.json', 'haxe-dual-binding-artifact-not-json', 'flight.broken-json.json'],
      ['flight.missing-export.json', 'haxe-dual-binding-gate-locator-absent', 'binding:draw'],
      ['flight.missing-export.json', 'haxe-dual-binding-gate-vacuous', 'lane:cpp'],
      ['flight.missing-export.json', 'haxe-dual-binding-gate-vacuous', 'lane:javascript'],
      ['flight.missing-export.json', 'haxe-dual-binding-gate-vacuous', 'lane:javascript'],
      ['flight.refused.json', 'haxe-dual-binding-gate-backing-refused', 'binding:draw'],
      ['flight.refused.json', 'haxe-dual-binding-gate-vacuous', 'lane:cpp'],
    ]);
    expect(report.failures[0]?.detail).toContain('JSON');
    expect(report.failures[1]?.detail).toContain('./tiny.mjs exports no absent');
    expect(report.failures[5]?.detail).toContain('no C++ declaration was emitted for this export route');
  });

  it('reports an artifact directory it cannot read instead of failing the run outright', async () => {
    const report = await runHaxeDualBindingGateChecks({
      artifactDirectory: path.join(tmpdir(), 'haxe-dual-binding-absent-directory'),
      cpp: { includeDirectories: [] },
    });

    expect(report.artifacts).toEqual([]);
    expect(report.failures.map((failure) => failure.rule)).toEqual(['haxe-dual-binding-artifact-directory-unreadable']);
    expect(getHaxeDualBindingRunSummary(report).failures).toBe(1);
  });

  it('answers the same run twice for the same artifacts', async () => {
    const workspace = createFixtureWorkspace();
    writeFileSync(path.join(workspace.artifactDirectory, 'flight.render.json'), JSON.stringify(completeArtifact()));
    const options = { artifactDirectory: workspace.artifactDirectory, cpp: workspace.cpp, js: workspace.js };

    const first = await runHaxeDualBindingGateChecks(options);
    const second = await runHaxeDualBindingGateChecks(options);

    expect(first).toEqual(second);
    expect(formatHaxeDualBindingGateRunReport(first)).toBe(formatHaxeDualBindingGateRunReport(second));
  });
});

describe('getHaxeDualBindingRunSummary', () => {
  it('counts verified names and unchecked bindings across lanes', async () => {
    const workspace = createFixtureWorkspace();
    writeFileSync(path.join(workspace.artifactDirectory, 'flight.render.json'), JSON.stringify(completeArtifact()));

    const report = await runHaxeDualBindingGateChecks({
      artifactDirectory: workspace.artifactDirectory,
      cpp: { ...workspace.cpp, compiler: null },
      js: workspace.js,
    });

    expect(getHaxeDualBindingRunSummary(report)).toEqual({ callables: 1, failures: 2, types: 1, unchecked: 2 });
  });
});

describe('formatHaxeDualBindingGateRunReport', () => {
  it('prints the summary, every failure, and each lane with its unchecked bindings', async () => {
    const workspace = createFixtureWorkspace();
    writeFileSync(path.join(workspace.artifactDirectory, 'flight.render.json'), JSON.stringify(completeArtifact()));

    const text = formatHaxeDualBindingGateRunReport(
      await runHaxeDualBindingGateChecks({
        artifactDirectory: workspace.artifactDirectory,
        cpp: { ...workspace.cpp, compiler: null },
        js: workspace.js,
      }),
    );

    expect(text).toContain(
      '1 artifact(s), 2 failure(s), 1 type(s) and 1 callable(s) verified, 2 selection(s) unchecked',
    );
    expect(text).toContain(
      'flight.render.json: haxe-dual-binding-gate-vacuous lane:cpp: the cpp backing verified no type',
    );
    expect(text).toContain('flight.render.json cpp: 0 type(s), 0 callable(s), 2 unchecked');
    expect(text).toContain('unchecked: binding:draw (tiny.hpp flight::dual::draw)');
  });
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { produceCompilerHaxeBindingCheckpoint } from './compilerHaxeBindingCheckpoint.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('produceCompilerHaxeBindingCheckpoint', () => {
  it('writes exact public-plan, ESM, public, _js, and _cpp artifacts deterministically from real planner APIs', () => {
    const fixture = createCompilerHaxeBindingCheckpointFixture();
    const options = {
      cppDirectory: fixture.cppDirectory,
      flightDirectory: fixture.flightDirectory,
      outputDirectory: fixture.outputDirectory,
    };

    const first = produceCompilerHaxeBindingCheckpoint(options);
    const firstSnapshot = snapshotCompilerHaxeBindingCheckpointDirectory(fixture.outputDirectory);
    writeFileSync(path.join(fixture.outputDirectory, 'stale.txt'), 'must be removed');
    const second = produceCompilerHaxeBindingCheckpoint(options);
    const secondSnapshot = snapshotCompilerHaxeBindingCheckpointDirectory(fixture.outputDirectory);

    expect(second.plan).toEqual(first.plan);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot).not.toHaveProperty('stale.txt');
    expect(JSON.parse(readFileSync(path.join(first.planArtifactDirectory, 'flight-folded.json'), 'utf8'))).toEqual(
      first.plan,
    );
    expect(first.plan.schema).toBe('flight-haxe-dual-binding-plan/1');
    expect(first.plan.bindings).toHaveLength(2);
    expect(first.plan.bindings.every((binding) => binding.cpp.availability === 'available')).toBe(true);
    expect(first.plan.bindings.every((binding) => binding.javascript.availability === 'available')).toBe(true);
    expect(first.haxeRefusals).toEqual([]);

    expect(secondSnapshot).toHaveProperty('haxe/flight/BatchBarrier.hx');
    expect(secondSnapshot).toHaveProperty('haxe/flight/Color.hx');
    expect(secondSnapshot).toHaveProperty('haxe/flight/_cpp/BatchBarrier.hx');
    expect(secondSnapshot).toHaveProperty('haxe/flight/_cpp/_fn/Color.hx');
    expect(secondSnapshot).toHaveProperty('haxe/flight/_js/BatchBarrier.hx');
    expect(secondSnapshot).toHaveProperty('haxe/flight/_js/_fn/Color.hx');
    expect(secondSnapshot['haxe/flight/Color.hx']).toContain('flight._js._fn.Color.colorFromKelvin');
    expect(secondSnapshot['haxe/flight/Color.hx']).toContain('flight._cpp._fn.Color.colorFromKelvin');
    expect(secondSnapshot['modules/flighthq-types.mjs']).toContain('export var BatchBarrier');
    expect(secondSnapshot['modules/flighthq-color.mjs']).toContain('export function colorFromKelvin');

    const refused = JSON.parse(
      readFileSync(path.join(first.refusalArtifactDirectory, 'flight-refused.json'), 'utf8'),
    ) as { bindings: { cpp: { availability: string; refusal?: { message?: string } } }[] };
    expect(refused.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cpp: expect.objectContaining({
            availability: 'refused',
            refusal: expect.objectContaining({ message: expect.stringContaining('SharedArrayBuffer[type]') }),
          }),
        }),
      ]),
    );
    expect(first.cppIncludeDirectories).toEqual([
      path.join(fixture.cppDirectory, 'include'),
      path.join(fixture.cppDirectory, 'generated', 'include'),
    ]);
    expect(first.cppSlicePaths).toEqual([path.join(fixture.cppDirectory, 'src', 'c_runtime.cpp')]);
  });
});

function createCompilerHaxeBindingCheckpointFixture(): {
  readonly cppDirectory: string;
  readonly flightDirectory: string;
  readonly outputDirectory: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), 'compiler-haxe-binding-checkpoint-'));
  directories.push(directory);
  const cppDirectory = path.join(directory, 'flight-cpp');
  const flightDirectory = path.join(directory, 'flight');
  const outputDirectory = path.join(directory, 'output');
  writeCompilerHaxeBindingCheckpointFixtureFile(
    flightDirectory,
    'packages/types/src/BatchBarrier.ts',
    'export enum BatchBarrier { Capacity, Clip }\n',
  );
  writeCompilerHaxeBindingCheckpointFixtureFile(
    flightDirectory,
    'packages/color/src/colorFromKelvin.ts',
    'export function colorFromKelvin(kelvin: number): number { return kelvin; }\n',
  );
  writeCompilerHaxeBindingCheckpointFixtureFile(
    flightDirectory,
    'packages/encoding/src/utf8.ts',
    'export function decodeUTF8(text: string): string { return text; }\n',
  );
  writeCompilerHaxeBindingCheckpointFixtureFile(cppDirectory, 'include/flight/runtime.hpp', '#pragma once\n');
  writeCompilerHaxeBindingCheckpointFixtureFile(
    cppDirectory,
    'generated/include/flight/types/batch_barrier.hpp',
    '#pragma once\n',
  );
  writeCompilerHaxeBindingCheckpointFixtureFile(
    cppDirectory,
    'generated/include/flight/color/color_from_kelvin.hpp',
    '#pragma once\n',
  );
  writeCompilerHaxeBindingCheckpointFixtureFile(cppDirectory, 'src/c_runtime.cpp', '\n');
  writeCompilerHaxeBindingCheckpointFixtureFile(
    cppDirectory,
    'generated/refusals.json',
    `${JSON.stringify(
      {
        refusals: [
          {
            code: 'unsupported-ir',
            module: 'packages/encoding/src/utf8.ts',
            package: '@flighthq/encoding',
            reason:
              'cpp emission failed for @flighthq/encoding/packages/encoding/src/utf8.ts: runtime external symbol binding plan is incomplete (missing: SharedArrayBuffer[type])',
            stage: 'emission',
          },
        ],
        schema: 'flight-generated-sdk-refusals/2',
      },
      null,
      2,
    )}\n`,
  );
  return { cppDirectory, flightDirectory, outputDirectory };
}

function writeCompilerHaxeBindingCheckpointFixtureFile(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

function snapshotCompilerHaxeBindingCheckpointDirectory(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else
        result[path.relative(directory, absolutePath).split(path.sep).join('/')] = readFileSync(absolutePath, 'utf8');
    }
  };
  visit(directory);
  return result;
}

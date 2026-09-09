import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileTypeScriptModules,
  createCppCompilerBackend,
  createHaxeCompilerBackend,
  createRustCompilerBackend,
  isBackendEmissionFailure,
  parseTypeScriptSource,
} from '../packages/tool-compiler/src/index.js';
import type { CompilerBackend } from '../packages/compiler-types/src/index.js';

// Byte-for-byte emission fixtures: the compiler's output is its product, and a unit test asserting a
// substring of one line cannot see a change to the rest of the file. Each fixture compiles one
// TypeScript source through both backends and compares the whole emitted tree against committed text.
//
// A fixture may also pin a refusal. What this compiler declines to lower is as much a part of its
// contract as what it emits, and a construct silently becoming "supported" with approximate output
// would otherwise pass unnoticed.
//
// `npm run golden` rewrites the committed output; `npm run golden:check` runs only these fixtures.
// The write mode exists because hand-editing emitted text invites a reviewer to accept a diff the
// compiler did not actually produce — regenerate, then read the diff as the change it is.

const goldenDirectory = path.dirname(fileURLToPath(import.meta.url));
const updating = process.env.FLIGHT_GOLDEN_UPDATE === '1';
const backendNames = ['cpp', 'haxe', 'rust'] as const;

const fixtures = readdirSync(goldenDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(goldenDirectory, entry.name, 'input.ts')))
  .map((entry) => entry.name)
  .sort();

describe('golden emission fixtures', () => {
  // A harness that silently found no fixtures would report the same green a complete run does.
  it('discovers at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    for (const name of backendNames) {
      it(`${fixture} emits stable ${name}`, () => {
        const outputDirectory = path.join(goldenDirectory, fixture, name);
        const errorFile = path.join(goldenDirectory, fixture, `${name}.error.txt`);
        const emitted = compile(fixture, name);

        if (emitted.kind === 'refused') {
          if (updating) {
            rmSync(outputDirectory, { force: true, recursive: true });
            writeFileSync(errorFile, `${emitted.message}\n`);
            return;
          }
          expect(existsSync(errorFile), `${fixture}/${name} was refused but pins no expected message`).toBe(true);
          expect(emitted.message).toBe(readFileSync(errorFile, 'utf8').trimEnd());
          return;
        }

        if (updating) {
          rmSync(errorFile, { force: true });
          rmSync(outputDirectory, { force: true, recursive: true });
          for (const file of emitted.files) {
            const target = path.join(outputDirectory, file.path);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, file.contents);
          }
          return;
        }

        expect(existsSync(errorFile), `${fixture}/${name} emitted output but pins a refusal`).toBe(false);
        expect(emitted.files.map((file) => file.path)).toEqual(committedPaths(outputDirectory));
        for (const file of emitted.files) {
          expect(file.contents, `${fixture}/${name}/${file.path}`).toBe(
            readFileSync(path.join(outputDirectory, file.path), 'utf8'),
          );
        }
      });
    }
  }
});

type Emitted =
  | { readonly files: readonly { readonly contents: string; readonly path: string }[]; readonly kind: 'emitted' }
  | { readonly kind: 'refused'; readonly message: string };

function committedPaths(outputDirectory: string): string[] {
  if (!existsSync(outputDirectory)) return [];
  const walk = (directory: string, prefix: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
  return walk(outputDirectory, '').sort();
}

function compile(fixture: string, backendName: (typeof backendNames)[number]): Emitted {
  const fixtureDirectory = path.join(goldenDirectory, fixture);
  const file = path.join(fixtureDirectory, 'input.ts');
  const sourceFile = parseTypeScriptSource(`/flight/packages/golden/src/${fixture}.ts`, readFileSync(file, 'utf8'));
  const sources: {
    packageName: string;
    sourceFile: ReturnType<typeof parseTypeScriptSource>;
    upstreamDirectory: string;
  }[] = [{ packageName: '@flighthq/golden', sourceFile, upstreamDirectory: '/flight' }];
  for (const entry of readdirSync(fixtureDirectory)) {
    if (entry === 'input.ts' || !entry.endsWith('.ts')) continue;
    const siblingName = entry.replace(/\.ts$/u, '');
    const siblingFile = parseTypeScriptSource(
      `/flight/packages/golden/src/${siblingName}.ts`,
      readFileSync(path.join(fixtureDirectory, entry), 'utf8'),
    );
    sources.push({ packageName: '@flighthq/golden', sourceFile: siblingFile, upstreamDirectory: '/flight' });
  }
  try {
    const result =
      backendName === 'cpp'
        ? compileWithBackend(createCppCompilerBackend(), { runtimeProfile: 'flight-cpp' }, sources)
        : backendName === 'haxe'
          ? compileWithBackend(createHaxeCompilerBackend(), {}, sources)
          : compileWithBackend(createRustCompilerBackend(), {}, sources);
    return { files: result.compilation.files, kind: 'emitted' };
  } catch (error) {
    if (isBackendEmissionFailure(error)) return { kind: 'refused', message: error.message };
    throw error;
  }
}

function compileWithBackend<Options>(
  backend: CompilerBackend<Options>,
  backendOptions: Readonly<Options>,
  sources: readonly {
    readonly packageName: string;
    readonly sourceFile: ReturnType<typeof parseTypeScriptSource>;
    readonly upstreamDirectory: string;
  }[],
) {
  return compileTypeScriptModules({ backend, backendOptions, sources });
}

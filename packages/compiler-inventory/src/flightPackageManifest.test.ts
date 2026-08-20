import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { readFlightPackageManifests } from './flightPackageManifest.js';

describe('readFlightPackageManifests', () => {
  it('returns sorted portable manifest facts with merged production dependencies and bin shapes', () => {
    const upstream = createDirectory();
    try {
      writeManifest(upstream, 'zeta', {
        bin: './dist/cli.js',
        dependencies: { zeta: '^1' },
        name: '@flighthq/zeta',
        optionalDependencies: { alpha: '^1' },
        peerDependencies: { zeta: '^2' },
        version: '1.0.0',
      });
      writeManifest(upstream, 'alpha', {
        bin: { second: './dist/second.js', first: './dist/first.js' },
        name: '@flighthq/alpha',
        version: '2.0.0',
      });
      mkdirSync(path.join(upstream, 'packages', 'not-a-package'));

      const manifests = readFlightPackageManifests({ upstreamDirectory: upstream });

      expect(manifests).toEqual([
        {
          bins: [
            { name: 'first', target: './dist/first.js' },
            { name: 'second', target: './dist/second.js' },
          ],
          dependencies: [],
          directory: 'packages/alpha',
          name: '@flighthq/alpha',
          version: '2.0.0',
        },
        {
          bins: [{ name: 'default', target: './dist/cli.js' }],
          dependencies: ['alpha', 'zeta'],
          directory: 'packages/zeta',
          name: '@flighthq/zeta',
          version: '1.0.0',
        },
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('accepts an empty packages directory and custom relative package location and scope', () => {
    const upstream = createDirectory();
    try {
      expect(readFlightPackageManifests({ upstreamDirectory: upstream })).toEqual([]);
      writeManifest(upstream, 'math', { name: '@example/math', version: '0.0.0' }, path.join('workspace', 'modules'));

      expect(
        readFlightPackageManifests({
          packageScope: '@example',
          packagesDirectory: 'workspace/modules',
          upstreamDirectory: upstream,
        }),
      ).toEqual([expect.objectContaining({ directory: 'workspace/modules/math', name: '@example/math' })]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('fails with stable codes for invalid directory, JSON, metadata, scope, dependencies, bins, and duplicates', () => {
    const cases: Array<{
      code:
        | 'duplicate-package-name'
        | 'invalid-package-directory'
        | 'invalid-package-manifest'
        | 'invalid-package-scope'
        | 'missing-packages-directory';
      prepare: (upstream: string) => Parameters<typeof readFlightPackageManifests>[0];
    }> = [
      {
        code: 'missing-packages-directory',
        prepare: (upstream) => ({ packagesDirectory: 'missing', upstreamDirectory: upstream }),
      },
      {
        code: 'invalid-package-directory',
        prepare: (upstream) => ({ packagesDirectory: '..', upstreamDirectory: upstream }),
      },
      {
        code: 'invalid-package-manifest',
        prepare: (upstream) => {
          write(upstream, 'packages/math/package.json', '{ invalid');
          return { upstreamDirectory: upstream };
        },
      },
      {
        code: 'invalid-package-manifest',
        prepare: (upstream) => {
          writeManifest(upstream, 'math', { name: '@flighthq/math' });
          return { upstreamDirectory: upstream };
        },
      },
      {
        code: 'invalid-package-scope',
        prepare: (upstream) => {
          writeManifest(upstream, 'math', { name: '@other/math', version: '0.0.0' });
          return { upstreamDirectory: upstream };
        },
      },
      {
        code: 'invalid-package-manifest',
        prepare: (upstream) => {
          writeManifest(upstream, 'math', {
            dependencies: { typescript: 5 },
            name: '@flighthq/math',
            version: '0.0.0',
          });
          return { upstreamDirectory: upstream };
        },
      },
      {
        code: 'invalid-package-manifest',
        prepare: (upstream) => {
          writeManifest(upstream, 'math', { bin: [], name: '@flighthq/math', version: '0.0.0' });
          return { upstreamDirectory: upstream };
        },
      },
      {
        code: 'duplicate-package-name',
        prepare: (upstream) => {
          writeManifest(upstream, 'math-a', { name: '@flighthq/math', version: '0.0.0' });
          writeManifest(upstream, 'math-b', { name: '@flighthq/math', version: '0.0.0' });
          return { upstreamDirectory: upstream };
        },
      },
    ];

    for (const testCase of cases) {
      const upstream = createDirectory();
      try {
        let failure: unknown;
        try {
          readFlightPackageManifests(testCase.prepare(upstream));
        } catch (error) {
          failure = error;
        }
        expect(isCompilerInventoryFailure(failure), testCase.code).toBe(true);
        expect(failure).toMatchObject({ code: testCase.code, kind: 'compiler-inventory' });
      } finally {
        rmSync(upstream, { force: true, recursive: true });
      }
    }
  });
});

function createDirectory(packagesDirectory = 'packages'): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-package-manifest-'));
  mkdirSync(path.join(directory, packagesDirectory), { recursive: true });
  return directory;
}

function writeManifest(
  upstream: string,
  directory: string,
  manifest: Readonly<Record<string, unknown>>,
  packagesDirectory = 'packages',
): void {
  write(upstream, path.join(packagesDirectory, directory, 'package.json'), JSON.stringify(manifest));
}

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

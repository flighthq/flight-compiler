import type { AnalyzeFlightWorkspaceOptions } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { readFlightPackageManifests } from './flightPackageManifest.js';
import { createMemoryWorkspaceSource } from './memoryWorkspaceSource.js';

// The workspace is described rather than built. A directory exists here because a file inside it
// does, so a package directory that should be skipped carries a non-manifest file rather than being
// empty — which exercises the same rule and keeps the fixture readable in one place.
const upstreamDirectory = '/flight';

function manifest(contents: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(contents);
}

function read(files: Readonly<Record<string, string>>, options: Partial<AnalyzeFlightWorkspaceOptions> = {}): unknown {
  return readFlightPackageManifests({ upstreamDirectory, ...options }, createMemoryWorkspaceSource(files));
}

describe('readFlightPackageManifests', () => {
  it('returns sorted portable manifest facts with merged production dependencies and bin shapes', () => {
    const manifests = read({
      '/flight/packages/alpha/package.json': manifest({
        bin: { first: './dist/first.js', second: './dist/second.js' },
        name: '@flighthq/alpha',
        version: '2.0.0',
      }),
      '/flight/packages/not-a-package/README.md': '# not a package\n',
      '/flight/packages/zeta/package.json': manifest({
        bin: './dist/cli.js',
        dependencies: { zeta: '^1' },
        name: '@flighthq/zeta',
        optionalDependencies: { alpha: '^1' },
        peerDependencies: { zeta: '^2' },
        version: '1.0.0',
      }),
    });

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
  });

  it('accepts a packages directory holding no packages', () => {
    expect(read({ '/flight/packages/.keep': '' })).toEqual([]);
  });

  it('accepts a custom relative package location and scope', () => {
    expect(
      read(
        { '/flight/workspace/modules/math/package.json': manifest({ name: '@example/math', version: '0.0.0' }) },
        { packageScope: '@example', packagesDirectory: 'workspace/modules' },
      ),
    ).toEqual([expect.objectContaining({ directory: 'workspace/modules/math', name: '@example/math' })]);
  });

  it('fails with stable codes for invalid directory, JSON, metadata, scope, dependencies, bins, and duplicates', () => {
    const cases: Array<{
      code:
        | 'duplicate-package-name'
        | 'invalid-package-directory'
        | 'invalid-package-manifest'
        | 'invalid-package-scope'
        | 'missing-packages-directory';
      files: Readonly<Record<string, string>>;
      options?: Partial<AnalyzeFlightWorkspaceOptions>;
    }> = [
      {
        code: 'missing-packages-directory',
        files: { '/flight/packages/.keep': '' },
        options: { packagesDirectory: 'missing' },
      },
      {
        code: 'invalid-package-directory',
        files: { '/flight/packages/.keep': '' },
        options: { packagesDirectory: '..' },
      },
      { code: 'invalid-package-manifest', files: { '/flight/packages/math/package.json': '{ invalid' } },
      {
        code: 'invalid-package-manifest',
        files: { '/flight/packages/math/package.json': manifest({ name: '@flighthq/math' }) },
      },
      {
        code: 'invalid-package-scope',
        files: { '/flight/packages/math/package.json': manifest({ name: '@other/math', version: '0.0.0' }) },
      },
      {
        code: 'invalid-package-manifest',
        files: {
          '/flight/packages/math/package.json': manifest({
            dependencies: { typescript: 5 },
            name: '@flighthq/math',
            version: '0.0.0',
          }),
        },
      },
      {
        code: 'invalid-package-manifest',
        files: {
          '/flight/packages/math/package.json': manifest({ bin: [], name: '@flighthq/math', version: '0.0.0' }),
        },
      },
      {
        code: 'duplicate-package-name',
        files: {
          '/flight/packages/math-a/package.json': manifest({ name: '@flighthq/math', version: '0.0.0' }),
          '/flight/packages/math-b/package.json': manifest({ name: '@flighthq/math', version: '0.0.0' }),
        },
      },
    ];

    for (const testCase of cases) {
      let failure: unknown;
      try {
        read(testCase.files, testCase.options);
      } catch (error) {
        failure = error;
      }
      expect(isCompilerInventoryFailure(failure), testCase.code).toBe(true);
      expect(failure).toMatchObject({ code: testCase.code, kind: 'compiler-inventory' });
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FlightPackageManifest } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { analyzeFlightPackageImports } from './flightPackageImport.js';
import { createHostWorkspaceSource } from './hostWorkspaceSource.js';

describe('analyzeFlightPackageImports', () => {
  it('collects deterministic production import, re-export, import-equals, and dynamic-import facts', () => {
    const upstream = createDirectory();
    try {
      write(
        upstream,
        'packages/math/src/zeta.ts',
        "import type { Shape } from './shape.js';\nimport { value as shapeValue } from './shape.js';\nimport value from 'node:path';\nexport type * from './shape.js';\nexport * from '@flighthq/types';\nconst task = import('@playwright/test');\nimport fs = require('node:fs');\nvoid Shape; void shapeValue; void value; void task; void fs;\n",
      );
      write(upstream, 'packages/math/src/alpha.ts', "import 'electron';\nimport 'electron';\n");
      write(upstream, 'packages/math/src/nested/view.tsx', "import '@capacitor/core';\nexport const view = <div />;\n");
      write(upstream, 'packages/math/src/ignored.test.ts', "import '@tauri-apps/api';\n");
      write(upstream, 'packages/math/src/ignored.d.ts', "import '@capacitor/core';\n");

      const records = analyzeFlightPackageImports(
        { manifest: createManifest(), upstreamDirectory: upstream },
        createHostWorkspaceSource(),
      );

      expect(records).toEqual([
        {
          kind: 'import',
          source: 'packages/math/src/alpha.ts',
          specifier: 'electron',
          typeOnly: false,
        },
        {
          kind: 'import',
          source: 'packages/math/src/nested/view.tsx',
          specifier: '@capacitor/core',
          typeOnly: false,
        },
        {
          kind: 'import',
          source: 'packages/math/src/zeta.ts',
          specifier: './shape.js',
          typeOnly: false,
        },
        {
          kind: 'import',
          source: 'packages/math/src/zeta.ts',
          specifier: './shape.js',
          typeOnly: true,
        },
        {
          kind: 'reexport',
          source: 'packages/math/src/zeta.ts',
          specifier: './shape.js',
          typeOnly: true,
        },
        {
          kind: 'reexport',
          source: 'packages/math/src/zeta.ts',
          specifier: '@flighthq/types',
          typeOnly: false,
        },
        {
          kind: 'dynamic',
          source: 'packages/math/src/zeta.ts',
          specifier: '@playwright/test',
          typeOnly: false,
        },
        {
          kind: 'importEquals',
          source: 'packages/math/src/zeta.ts',
          specifier: 'node:fs',
          typeOnly: false,
        },
        {
          kind: 'import',
          source: 'packages/math/src/zeta.ts',
          specifier: 'node:path',
          typeOnly: false,
        },
      ]);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('returns an empty result for a package without source and does not mutate its manifest', () => {
    const upstream = createDirectory();
    const manifest = createManifest();
    const before = structuredClone(manifest);
    try {
      expect(
        analyzeFlightPackageImports({ manifest, upstreamDirectory: upstream }, createHostWorkspaceSource()),
      ).toEqual([]);
      expect(manifest).toEqual(before);
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });

  it('rejects package paths outside the checkout and dynamic imports without one literal specifier', () => {
    const upstream = createDirectory();
    try {
      write(upstream, 'packages/math/src/value.ts', 'const name = "module"; void import(name);\n');
      const cases = [
        { manifest: { ...createManifest(), directory: '..' }, code: 'invalid-package-directory' },
        { manifest: createManifest(), code: 'unsupported-dynamic-import' },
      ] as const;

      for (const testCase of cases) {
        let failure: unknown;
        try {
          analyzeFlightPackageImports(
            { manifest: testCase.manifest, upstreamDirectory: upstream },
            createHostWorkspaceSource(),
          );
        } catch (error) {
          failure = error;
        }
        expect(isCompilerInventoryFailure(failure)).toBe(true);
        expect(failure).toMatchObject({ code: testCase.code, kind: 'compiler-inventory' });
      }
    } finally {
      rmSync(upstream, { force: true, recursive: true });
    }
  });
});

function createDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-package-import-'));
}

function createManifest(): FlightPackageManifest {
  return {
    bins: [],
    dependencies: [],
    directory: 'packages/math',
    name: '@flighthq/math',
    version: '0.0.0',
  };
}

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

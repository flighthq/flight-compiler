import type { FlightPackageManifest, PackageImportRecord } from '../../compiler-types/src/index.js';
import { analyzeFlightPackageHostFacts } from './flightPackageHostFacts.js';

describe('analyzeFlightPackageHostFacts', () => {
  it('classifies supported host ecosystems, removes duplicates, and ignores ordinary modules', () => {
    const manifest: FlightPackageManifest = {
      bins: [],
      dependencies: ['electron', '@tauri-apps/api', '@capacitor/core', '@playwright/test', '@flighthq/types'],
      directory: 'packages/tool-capture',
      name: '@flighthq/tool-capture',
      version: '0.0.0',
    };
    const imports: PackageImportRecord[] = [
      createImport('node:fs'),
      createImport('@playwright/test'),
      createImport('@playwright/test'),
      createImport('@flighthq/types'),
    ];

    expect(analyzeFlightPackageHostFacts(manifest, imports)).toEqual({
      dependencies: [
        { kind: 'capacitor', specifier: '@capacitor/core' },
        { kind: 'electron', specifier: 'electron' },
        { kind: 'playwright', specifier: '@playwright/test' },
        { kind: 'tauri', specifier: '@tauri-apps/api' },
      ],
      imports: [
        { kind: 'node', specifier: 'node:fs' },
        { kind: 'playwright', specifier: '@playwright/test' },
      ],
    });
  });

  it('returns empty facts without mutating caller-owned manifest or import records', () => {
    const manifest: FlightPackageManifest = {
      bins: [],
      dependencies: ['@flighthq/types'],
      directory: 'packages/math',
      name: '@flighthq/math',
      version: '0.0.0',
    };
    const imports = [createImport('./value.js')];
    const before = structuredClone({ imports, manifest });

    expect(analyzeFlightPackageHostFacts(manifest, imports)).toEqual({ dependencies: [], imports: [] });
    expect({ imports, manifest }).toEqual(before);
  });
});

function createImport(specifier: string): PackageImportRecord {
  return { kind: 'import', source: 'packages/math/src/index.ts', specifier, typeOnly: false };
}

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  FlightPackageManifest,
  PackageHostFacts,
  PackageHostKind,
  PackageHostModuleReference,
  PackageImportRecord,
} from '../../compiler-types/src/index.js';

export function analyzeFlightPackageHostFacts(
  manifest: Readonly<FlightPackageManifest>,
  imports: readonly Readonly<PackageImportRecord>[],
): PackageHostFacts {
  return {
    dependencies: createHostModuleReferences(manifest.dependencies),
    imports: createHostModuleReferences(imports.map((record) => record.specifier)),
  };
}

function compareHostModuleReferences(
  left: Readonly<PackageHostModuleReference>,
  right: Readonly<PackageHostModuleReference>,
): number {
  return compareTextCodeUnits(left.kind, right.kind) || compareTextCodeUnits(left.specifier, right.specifier);
}

function createHostModuleReferences(specifiers: readonly string[]): PackageHostModuleReference[] {
  const references = new Map<string, PackageHostModuleReference>();
  for (const specifier of specifiers) {
    const kind = getHostModuleKind(specifier);
    if (kind) references.set(`${kind}\0${specifier}`, { kind, specifier });
  }
  return [...references.values()].sort(compareHostModuleReferences);
}

function getHostModuleKind(specifier: string): PackageHostKind | undefined {
  if (specifier.startsWith('node:')) return 'node';
  if (specifier === '@playwright/test' || specifier.startsWith('@playwright/')) return 'playwright';
  if (specifier === 'electron') return 'electron';
  if (specifier.startsWith('@capacitor/')) return 'capacitor';
  if (specifier.startsWith('@tauri-apps/')) return 'tauri';
  return undefined;
}

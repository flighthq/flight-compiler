import { compareTextCodeUnits } from '../../compiler-ordering/src/index.js';
import type {
  AnalyzeFlightPackageExclusionsOptions,
  PackageExclusion,
  PackageHostModuleReference,
  PackageInventory,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

interface PackageExclusionClaim {
  readonly exclusion?: PackageExclusion | undefined;
  readonly missing: readonly string[];
  readonly packageName: string;
}

export function analyzeFlightPackageExclusions(
  options: Readonly<AnalyzeFlightPackageExclusionsOptions>,
): ReadonlyMap<string, PackageExclusion> {
  const claims = options.packages
    .map(createPackageExclusionClaim)
    .filter((claim): claim is PackageExclusionClaim => claim !== undefined)
    .sort((left, right) => compareTextCodeUnits(left.packageName, right.packageName));
  const partial = claims.filter((claim) => claim.missing.length > 0);
  if (partial.length > 0) {
    const subject = partial.map((claim) => claim.packageName).join(',');
    throw createCompilerInventoryFailure(
      'package-exclusion-drift',
      subject,
      `Partial package exclusion matches:\n${partial
        .map((claim) => `- ${claim.packageName}: ${claim.missing.join(', ')}`)
        .join('\n')}`,
    );
  }

  const exclusions = new Map(claims.map((claim) => [claim.packageName, claim.exclusion!] as const));
  if (options.expectedPackageNames) {
    const expected = [...new Set(options.expectedPackageNames)].sort(compareTextCodeUnits);
    const actual = [...exclusions.keys()].sort(compareTextCodeUnits);
    if (!sameTextLists(expected, actual)) {
      throw createCompilerInventoryFailure(
        'package-exclusion-drift',
        actual.join(',') || '<none>',
        `Package exclusions changed: expected ${expected.join(', ') || '<none>'}; found ${actual.join(', ') || '<none>'}`,
      );
    }
  }
  return exclusions;
}

function createPackageExclusionClaim(item: Readonly<PackageInventory>): PackageExclusionClaim | undefined {
  const playwrightDependencies = selectHostModules(item.hostFacts.dependencies, 'playwright');
  const playwrightImports = selectHostModules(item.hostFacts.imports, 'playwright');
  if (item.bins.length === 0 && playwrightDependencies.length === 0 && playwrightImports.length === 0) {
    return undefined;
  }
  const nodeImports = selectHostModules(item.hostFacts.imports, 'node');
  const unsupportedDependencies = item.hostFacts.dependencies.filter(
    (reference) => reference.kind !== 'node' && reference.kind !== 'playwright',
  );
  const unsupportedImports = item.hostFacts.imports.filter(
    (reference) => reference.kind !== 'node' && reference.kind !== 'playwright',
  );
  const missing: string[] = [];
  if (item.bins.length === 0) missing.push('missing tooling bin lane');
  if (item.sdkExposures.length > 0) missing.push('present in SDK export lanes');
  if (nodeImports.length === 0) missing.push('missing production node import');
  if (playwrightDependencies.length === 0) missing.push('missing Playwright production dependency');
  if (playwrightImports.length === 0) missing.push('missing production Playwright import');
  if (unsupportedDependencies.length > 0) {
    missing.push(`unsupported host dependencies (${formatHostModules(unsupportedDependencies)})`);
  }
  if (unsupportedImports.length > 0) {
    missing.push(`unsupported host imports (${formatHostModules(unsupportedImports)})`);
  }

  return {
    ...(missing.length === 0
      ? {
          exclusion: {
            evidence: {
              bins: item.bins.map((entry) => ({ ...entry })),
              hostDependencies: item.hostFacts.dependencies.map((reference) => ({ ...reference })),
              hostImports: item.hostFacts.imports.map((reference) => ({ ...reference })),
              sdkExposures: item.sdkExposures.map((exposure) => ({ ...exposure })),
            },
            reason: `Tooling package with ${String(item.bins.length)} bin lane, no SDK exposure, and production host use limited to Node and Playwright.`,
            rule: 'node-playwright-tooling' as const,
          },
        }
      : {}),
    missing,
    packageName: item.name,
  };
}

function formatHostModules(references: readonly Readonly<PackageHostModuleReference>[]): string {
  return references
    .map((reference) => reference.specifier)
    .sort(compareTextCodeUnits)
    .join(', ');
}

function sameTextLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function selectHostModules(
  references: readonly Readonly<PackageHostModuleReference>[],
  kind: PackageHostModuleReference['kind'],
): PackageHostModuleReference[] {
  return references.filter((reference) => reference.kind === kind);
}

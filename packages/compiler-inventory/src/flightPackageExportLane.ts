import type { PackageExportLane, PackageInventory } from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

export function getPackageInventoryRootExportLane(inventory: Readonly<PackageInventory>): PackageExportLane {
  const lane = inventory.exportLanes.find((candidate) => candidate.entry === '.');
  if (!lane) {
    throw createCompilerInventoryFailure(
      'missing-package-export',
      inventory.name,
      `Package manifest has no root export lane: ${inventory.name}`,
    );
  }
  return lane;
}

export function resolvePackageExportLane(
  inventoryByName: ReadonlyMap<string, PackageInventory>,
  specifier: string,
  packageScope = '@flighthq',
): PackageExportLane {
  const escapedScope = escapeRegularExpression(packageScope);
  const match = new RegExp(`^(${escapedScope}/[^/]+)(?<subpath>/.*)?$`, 'u').exec(specifier);
  const packageName = match?.[1];
  if (!packageName) {
    throw createCompilerInventoryFailure(
      'unsupported-package-specifier',
      specifier,
      `Unsupported Flight package specifier: ${specifier}`,
    );
  }
  const inventory = inventoryByName.get(packageName);
  if (!inventory) {
    throw createCompilerInventoryFailure(
      'unknown-package',
      packageName,
      `Unknown Flight package in public import: ${packageName}`,
    );
  }
  const entry = match.groups?.subpath ? `.${match.groups.subpath}` : '.';
  const lane = inventory.exportLanes.find((candidate) => candidate.entry === entry);
  if (!lane) {
    throw createCompilerInventoryFailure(
      'missing-package-export',
      specifier,
      `Package import uses an unaccounted export lane: ${specifier}`,
    );
  }
  return lane;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

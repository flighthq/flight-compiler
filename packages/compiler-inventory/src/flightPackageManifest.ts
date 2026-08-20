import path from 'node:path';

import type {
  FlightPackageManifest,
  PackageBinEntry,
  ReadFlightPackageManifestsOptions,
  WorkspaceSource,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

export function readFlightPackageManifests(
  options: Readonly<ReadFlightPackageManifestsOptions>,
  source: WorkspaceSource,
): readonly FlightPackageManifest[] {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const packagesDirectory = path.resolve(upstreamDirectory, options.packagesDirectory ?? 'packages');
  const packageScope = options.packageScope ?? '@flighthq';
  const portablePackagesDirectory = relativeUpstreamPath(packagesDirectory, upstreamDirectory);
  if (!source.isDirectory(packagesDirectory)) {
    throw createCompilerInventoryFailure(
      'missing-packages-directory',
      portablePackagesDirectory,
      `Flight packages directory does not exist: ${portablePackagesDirectory}`,
    );
  }

  const manifests = source
    .listDirectory(packagesDirectory)
    .filter((entry) => entry.isDirectory)
    .map((entry) => path.join(packagesDirectory, entry.name, 'package.json'))
    .filter((manifestPath) => source.isFile(manifestPath))
    .map((manifestPath) => readFlightPackageManifest(manifestPath, upstreamDirectory, packageScope, source))
    .sort((left, right) => compareText(left.name, right.name));
  for (let index = 1; index < manifests.length; index += 1) {
    if (manifests[index - 1]!.name === manifests[index]!.name) {
      throw createCompilerInventoryFailure(
        'duplicate-package-name',
        manifests[index]!.name,
        `Flight package name is duplicated: ${manifests[index]!.name}`,
      );
    }
  }
  return manifests;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readFlightPackageManifest(
  manifestPath: string,
  upstreamDirectory: string,
  packageScope: string,
  source: WorkspaceSource,
): FlightPackageManifest {
  const subject = relativeUpstreamPath(manifestPath, upstreamDirectory);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.readTextFile(manifestPath)) as unknown;
  } catch (error) {
    throw createCompilerInventoryFailure(
      'invalid-package-manifest',
      subject,
      `Package manifest is not valid JSON: ${subject}`,
      error,
    );
  }
  if (!isRecord(parsed)) invalidManifest(subject, 'must contain a JSON object');
  const name = readRequiredString(parsed, 'name', subject);
  const version = readRequiredString(parsed, 'version', subject);
  if (!name.startsWith(`${packageScope}/`) || name.slice(packageScope.length + 1).includes('/')) {
    throw createCompilerInventoryFailure(
      'invalid-package-scope',
      name,
      `Package ${name} is outside configured scope ${packageScope}`,
    );
  }
  return {
    bins: readPackageBins(parsed.bin, subject),
    dependencies: readPackageDependencies(parsed, subject),
    directory: relativeUpstreamPath(path.dirname(manifestPath), upstreamDirectory),
    name,
    version,
  };
}

function invalidManifest(subject: string, detail: string): never {
  throw createCompilerInventoryFailure(
    'invalid-package-manifest',
    subject,
    `Invalid package manifest ${subject}: ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPackageBins(value: unknown, subject: string): PackageBinEntry[] {
  if (value === undefined) return [];
  if (typeof value === 'string' && value.length > 0) return [{ name: 'default', target: value }];
  if (!isRecord(value)) invalidManifest(subject, 'bin must be a nonempty string or string map');
  const bins = Object.entries(value).map(([name, target]): PackageBinEntry => {
    if (name.length === 0 || typeof target !== 'string' || target.length === 0) {
      return invalidManifest(subject, 'bin entries require nonempty names and string targets');
    }
    return { name, target };
  });
  return bins.sort((left, right) => compareText(left.name, right.name));
}

function readPackageDependencies(packageJson: Readonly<Record<string, unknown>>, subject: string): string[] {
  const names = new Set<string>();
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const value = packageJson[key];
    if (value === undefined) continue;
    if (!isRecord(value)) invalidManifest(subject, `${key} must be a string map`);
    for (const [name, version] of Object.entries(value)) {
      if (name.length === 0 || typeof version !== 'string' || version.length === 0) {
        invalidManifest(subject, `${key} entries require nonempty names and string versions`);
      }
      names.add(name);
    }
  }
  return [...names].sort(compareText);
}

function readRequiredString(packageJson: Readonly<Record<string, unknown>>, key: string, subject: string): string {
  const value = packageJson[key];
  return typeof value === 'string' && value.length > 0
    ? value
    : invalidManifest(subject, `${key} must be a nonempty string`);
}

function relativeUpstreamPath(target: string, upstreamDirectory: string): string {
  const relative = path.relative(upstreamDirectory, path.resolve(target));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createCompilerInventoryFailure(
      'invalid-package-directory',
      target,
      `Package directory is outside upstream checkout: ${target}`,
    );
  }
  return relative.split(path.sep).join('/');
}

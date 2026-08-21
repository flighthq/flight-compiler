import path from 'node:path';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  PackageExportCondition,
  PackageExportDescriptor,
  WorkspaceSource,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

interface FlightPackageExportManifestIdentity {
  directory: string;
  name: string;
}

export function readPackageExportManifest(
  packageDirectory: string,
  workspace: WorkspaceSource,
  upstreamDirectory = path.dirname(path.resolve(packageDirectory)),
): PackageExportDescriptor[] {
  const directory = path.resolve(packageDirectory);
  const packageJson = readJson(path.join(directory, 'package.json'), workspace);
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    const subject = portablePath(directory);
    throw createCompilerInventoryFailure('invalid-package-manifest', subject, `Invalid package metadata: ${subject}`);
  }
  return readPackageExportDescriptors(
    { directory, name: packageJson.name },
    path.resolve(upstreamDirectory),
    packageJson,
    workspace,
  );
}

function portablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function readJson(file: string, workspace: WorkspaceSource): Record<string, unknown> {
  try {
    const value = JSON.parse(workspace.readTextFile(file)) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('expected a JSON object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw createCompilerInventoryFailure(
      'invalid-package-manifest',
      portablePath(file),
      `Package manifest is not valid JSON: ${portablePath(file)}`,
      error,
    );
  }
}

function readPackageExportDescriptors(
  descriptor: Readonly<FlightPackageExportManifestIdentity>,
  upstreamDirectory: string,
  packageJson: Readonly<Record<string, unknown>>,
  workspace: WorkspaceSource,
): PackageExportDescriptor[] {
  const manifestExports = packageJson.exports;
  if (!manifestExports || typeof manifestExports !== 'object' || Array.isArray(manifestExports)) {
    throw createCompilerInventoryFailure(
      'invalid-package-export',
      descriptor.name,
      `Package manifest has no export map: ${descriptor.name}`,
    );
  }
  const descriptors = Object.entries(manifestExports).map(([entry, rawConditions]): PackageExportDescriptor => {
    if (entry !== '.' && !/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry)) {
      throw createCompilerInventoryFailure(
        'invalid-package-export',
        `${descriptor.name}${entry.slice(1)}`,
        `Unsupported package export lane '${entry}' in ${descriptor.name}`,
      );
    }
    if (!rawConditions || typeof rawConditions !== 'object' || Array.isArray(rawConditions)) {
      const subject = `${descriptor.name}${entry.slice(1)}`;
      throw createCompilerInventoryFailure(
        'invalid-package-export',
        subject,
        `Package export lane ${subject} has no condition map`,
      );
    }
    const conditionsRecord = rawConditions as Record<string, unknown>;
    const typesTarget = conditionsRecord.types;
    const defaultTarget = conditionsRecord.default;
    if (typeof typesTarget !== 'string' || typeof defaultTarget !== 'string') {
      const subject = `${descriptor.name}${entry.slice(1)}`;
      throw createCompilerInventoryFailure(
        'invalid-package-export',
        subject,
        `Package export lane ${subject} needs types and default targets`,
      );
    }
    const conditions = Object.entries(conditionsRecord)
      .map(([condition, target]): PackageExportCondition => {
        if (typeof target !== 'string') {
          throw createCompilerInventoryFailure(
            'invalid-package-export',
            `${descriptor.name}${entry.slice(1)}[${condition}]`,
            `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] is not a string target`,
          );
        }
        return {
          condition,
          source: relativeSource(
            sourceForExportTarget(descriptor, entry, condition, target, workspace),
            upstreamDirectory,
          ),
          target,
        };
      })
      .sort((left, right) => compareTextCodeUnits(left.condition, right.condition));
    return {
      conditions,
      entry,
      source: relativeSource(
        sourceForExportTarget(descriptor, entry, 'types', typesTarget, workspace),
        upstreamDirectory,
      ),
      specifier: entry === '.' ? descriptor.name : `${descriptor.name}${entry.slice(1)}`,
    };
  });
  if (!descriptors.some((entry) => entry.entry === '.')) {
    throw createCompilerInventoryFailure(
      'missing-package-export',
      descriptor.name,
      `Package manifest has no root export lane: ${descriptor.name}`,
    );
  }
  return descriptors.sort((left, right) => compareTextCodeUnits(left.entry, right.entry));
}

function relativeSource(file: string, upstreamDirectory: string): string {
  const relative = path.relative(upstreamDirectory, path.resolve(file));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const subject = portablePath(file);
    throw createCompilerInventoryFailure(
      'invalid-source-path',
      subject,
      `Source is outside upstream checkout: ${subject}`,
    );
  }
  return portablePath(relative);
}

function sourceForExportTarget(
  descriptor: Readonly<FlightPackageExportManifestIdentity>,
  entry: string,
  condition: string,
  target: string,
  workspace: WorkspaceSource,
): string {
  const match = /^\.\/dist\/(?<stem>.+?)\.(?:d\.[cm]?ts|[cm]?js)$/u.exec(target);
  const stem = match?.groups?.stem;
  if (!stem || stem.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw createCompilerInventoryFailure(
      'invalid-package-export',
      `${descriptor.name}${entry.slice(1)}[${condition}]`,
      `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] has an unaccounted target: ${target}`,
    );
  }
  const sourceBase = path.join(descriptor.directory, 'src', ...stem.split('/'));
  for (const candidate of [`${sourceBase}.ts`, `${sourceBase}.tsx`]) {
    if (workspace.isFile(candidate)) return candidate;
  }
  throw createCompilerInventoryFailure(
    'unresolved-source',
    `${descriptor.name}${entry.slice(1)}[${condition}]`,
    `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] has no source barrel for ${target}`,
  );
}

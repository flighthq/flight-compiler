import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleResolutionEdge,
  CompilerModuleResolutionFailure,
  CompilerModuleResolutionFailureCode,
  CompilerModuleResolutionPlan,
  UpstreamInventory,
} from '../../compiler-types/src/index.js';

export function createCompilerModuleResolutionPlan(
  inventory: Readonly<UpstreamInventory>,
): CompilerModuleResolutionPlan {
  if (!inventory || inventory.schema !== 'flight-compiler-inventory/2' || !Array.isArray(inventory.packages)) {
    throw createCompilerModuleResolutionFailure(
      'invalid-inventory',
      'inventory',
      'Module resolution requires a versioned upstream inventory',
    );
  }
  const edges: CompilerModuleResolutionEdge[] = [];
  const specifiers = new Set<string>();
  for (const packageInventory of inventory.packages) {
    if (
      !packageInventory ||
      typeof packageInventory.name !== 'string' ||
      packageInventory.name.length === 0 ||
      !Array.isArray(packageInventory.exportLanes)
    ) {
      throw createCompilerModuleResolutionFailure(
        'invalid-inventory',
        'packages',
        'Module resolution inventory contains invalid package data',
      );
    }
    for (const lane of packageInventory.exportLanes) {
      if (
        !lane ||
        typeof lane.specifier !== 'string' ||
        typeof lane.source !== 'string' ||
        lane.specifier.length === 0 ||
        (lane.specifier !== packageInventory.name && !lane.specifier.startsWith(`${packageInventory.name}/`))
      ) {
        throw createCompilerModuleResolutionFailure(
          'invalid-package-export-lane',
          packageInventory.name,
          `Package ${packageInventory.name} contains an invalid export lane`,
        );
      }
      const source = normalizePathPortable(lane.source);
      if (!isCompilerModuleResolutionSource(source)) {
        throw createCompilerModuleResolutionFailure(
          'invalid-package-export-lane',
          lane.specifier,
          `Package export ${lane.specifier} has an invalid source path`,
        );
      }
      if (specifiers.has(lane.specifier)) {
        throw createCompilerModuleResolutionFailure(
          'duplicate-package-specifier',
          lane.specifier,
          `Package export specifier ${lane.specifier} is duplicated`,
        );
      }
      specifiers.add(lane.specifier);
      edges.push({
        specifier: lane.specifier,
        target: { packageName: packageInventory.name, source },
      });
    }
  }
  return Object.freeze({
    edges: Object.freeze(
      edges
        .sort((left, right) => compareTextCodeUnits(left.specifier, right.specifier))
        .map((edge) => Object.freeze({ ...edge, target: Object.freeze({ ...edge.target }) })),
    ),
    schema: 'flight-compiler-module-resolution/1',
  });
}

export function isCompilerModuleResolutionFailure(value: unknown): value is CompilerModuleResolutionFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-module-resolution' &&
    'code' in value &&
    compilerModuleResolutionFailureCodes.has(value.code as CompilerModuleResolutionFailureCode) &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0
  );
}

function createCompilerModuleResolutionFailure(
  code: CompilerModuleResolutionFailureCode,
  subject: string,
  message: string,
): CompilerModuleResolutionFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-module-resolution' as const,
    subject,
  });
  failure.name = 'CompilerModuleResolutionError';
  return failure;
}

function isCompilerModuleResolutionSource(source: string): boolean {
  return (
    source.length > 0 &&
    !source.startsWith('/') &&
    !/^[A-Za-z]:/u.test(source) &&
    source.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

const compilerModuleResolutionFailureCodes = new Set<CompilerModuleResolutionFailureCode>([
  'duplicate-package-specifier',
  'invalid-inventory',
  'invalid-package-export-lane',
]);

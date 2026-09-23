import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type {
  FlightPackageEligibilityFailure,
  FlightPackageEligibilityFailureCode,
  FlightPackageEligibilityOptions,
  FlightPackageEligibilityPackage,
  FlightPackageEligibilityPlan,
  FlightPackageEligibilitySubsetExcludedRoot,
  FlightPackageEligibilitySubsetOptions,
  FlightPackageEligibilitySubsetPlan,
  FlightPackageEnvironment,
} from '../../compiler-types/src/index.js';

export function createFlightPackageEligibilityPlan(
  options: Readonly<FlightPackageEligibilityOptions>,
): FlightPackageEligibilityPlan {
  if (
    !options ||
    !Array.isArray(options.packages) ||
    !Array.isArray(options.selectedPackageNames) ||
    (options.environment !== undefined && !isFlightPackageEnvironment(options.environment))
  ) {
    throw createFlightPackageEligibilityFailure(
      options?.environment !== undefined && !isFlightPackageEnvironment(options.environment)
        ? 'invalid-environment'
        : 'invalid-selection',
      'selection',
      'Flight package eligibility requires packages, selected package names, and a supported environment',
    );
  }

  const packages = new Map<string, Readonly<FlightPackageEligibilityPackage>>();
  for (const [index, package_] of options.packages.entries()) {
    const subject = `packages[${String(index)}]`;
    if (!isFlightPackageEligibilityPackage(package_)) {
      throw createFlightPackageEligibilityFailure(
        'invalid-package',
        subject,
        `Flight package eligibility contains invalid package data at ${subject}`,
      );
    }
    if (packages.has(package_.name)) {
      throw createFlightPackageEligibilityFailure(
        'duplicate-package',
        package_.name,
        `Flight package eligibility contains duplicate package ${package_.name}`,
      );
    }
    packages.set(package_.name, package_);
  }

  const selectedPackageNames = new Set<string>();
  for (const [index, name] of options.selectedPackageNames.entries()) {
    if (typeof name !== 'string' || name.length === 0 || selectedPackageNames.has(name)) {
      throw createFlightPackageEligibilityFailure(
        'invalid-selection',
        `selectedPackageNames[${String(index)}]`,
        'Selected Flight package names must be unique nonempty strings',
      );
    }
    if (!packages.has(name)) {
      throw createFlightPackageEligibilityFailure(
        'unknown-package',
        name,
        `Selected Flight package is not present in the inventory: ${name}`,
      );
    }
    selectedPackageNames.add(name);
  }

  const packageNames = new Set<string>();
  const visit = (name: string, dependencyPath: readonly string[]): void => {
    if (packageNames.has(name)) return;
    const package_ = packages.get(name)!;
    if (package_.environment !== undefined && package_.environment !== options.environment) {
      throw createFlightPackageEligibilityFailure(
        'ineligible-package-environment',
        name,
        options.environment === undefined
          ? `Package ${name} requires the ${package_.environment} environment, but no environment was selected`
          : `Package ${name} requires the ${package_.environment} environment, but ${options.environment} was selected`,
        {
          dependencyPath,
          requiredEnvironment: package_.environment,
          selectedEnvironment: options.environment ?? null,
        },
      );
    }
    packageNames.add(name);
    for (const dependency of package_.dependencies
      .filter((candidate) => packages.has(candidate))
      .sort(compareTextCodeUnits)) {
      visit(dependency, [...dependencyPath, dependency]);
    }
  };

  for (const name of [...selectedPackageNames].sort(compareTextCodeUnits)) visit(name, [name]);

  return Object.freeze({
    eligiblePackageNames: Object.freeze([...packageNames].sort(compareTextCodeUnits)),
    environment: options.environment ?? null,
    schema: 'flight-compiler-package-eligibility/1',
  });
}

export function createFlightPackageEligibilitySubsetPlan(
  options: Readonly<FlightPackageEligibilitySubsetOptions>,
): FlightPackageEligibilitySubsetPlan {
  if (!options || !Array.isArray(options.candidatePackageNames)) {
    throw createFlightPackageEligibilityFailure(
      'invalid-selection',
      'candidatePackageNames',
      'Flight package eligibility subset requires candidate package names',
    );
  }

  createFlightPackageEligibilityPlan({
    environment: options.environment,
    packages: options.packages,
    selectedPackageNames: [],
  });

  const packageNames = new Set(options.packages.map((package_) => package_.name));
  const candidatePackageNames = new Set<string>();
  for (const [index, name] of options.candidatePackageNames.entries()) {
    if (typeof name !== 'string' || name.length === 0 || candidatePackageNames.has(name)) {
      throw createFlightPackageEligibilityFailure(
        'invalid-selection',
        `candidatePackageNames[${String(index)}]`,
        'Candidate Flight package names must be unique nonempty strings',
      );
    }
    if (!packageNames.has(name)) {
      throw createFlightPackageEligibilityFailure(
        'unknown-package',
        name,
        `Candidate Flight package is not present in the inventory: ${name}`,
      );
    }
    candidatePackageNames.add(name);
  }

  const excludedRoots: FlightPackageEligibilitySubsetExcludedRoot[] = [];
  const includedPackageNames = new Set<string>();
  for (const name of [...candidatePackageNames].sort(compareTextCodeUnits)) {
    try {
      const plan = createFlightPackageEligibilityPlan({
        environment: options.environment,
        packages: options.packages,
        selectedPackageNames: [name],
      });
      for (const packageName of plan.eligiblePackageNames) includedPackageNames.add(packageName);
    } catch (error) {
      if (
        !isFlightPackageEligibilityFailure(error) ||
        error.code !== 'ineligible-package-environment' ||
        error.dependencyPath === undefined ||
        error.requiredEnvironment === undefined ||
        error.selectedEnvironment === undefined
      ) {
        throw error;
      }
      excludedRoots.push(
        Object.freeze({
          dependencyPath: Object.freeze([...error.dependencyPath]),
          name,
          requiredEnvironment: error.requiredEnvironment,
          selectedEnvironment: error.selectedEnvironment,
        }),
      );
    }
  }

  return Object.freeze({
    environment: options.environment ?? null,
    excludedRoots: Object.freeze(excludedRoots),
    includedPackageNames: Object.freeze([...includedPackageNames].sort(compareTextCodeUnits)),
    schema: 'flight-compiler-package-eligibility-subset/1',
  });
}

export function isFlightPackageEligibilityFailure(value: unknown): value is FlightPackageEligibilityFailure {
  if (
    !(value instanceof Error) ||
    !('kind' in value) ||
    value.kind !== 'flight-package-eligibility' ||
    !('code' in value) ||
    !flightPackageEligibilityFailureCodes.has(value.code as FlightPackageEligibilityFailureCode) ||
    !('subject' in value) ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0
  ) {
    return false;
  }
  if (value.code !== 'ineligible-package-environment') return true;
  return (
    'dependencyPath' in value &&
    Array.isArray(value.dependencyPath) &&
    value.dependencyPath.length > 0 &&
    value.dependencyPath.every((part: unknown) => typeof part === 'string' && part.length > 0) &&
    'requiredEnvironment' in value &&
    isFlightPackageEnvironment(value.requiredEnvironment) &&
    'selectedEnvironment' in value &&
    (value.selectedEnvironment === null || isFlightPackageEnvironment(value.selectedEnvironment))
  );
}

function createFlightPackageEligibilityFailure(
  code: FlightPackageEligibilityFailureCode,
  subject: string,
  message: string,
  detail: Readonly<
    Pick<FlightPackageEligibilityFailure, 'dependencyPath' | 'requiredEnvironment' | 'selectedEnvironment'>
  > = {},
): FlightPackageEligibilityFailure {
  const failure = Object.assign(new Error(message), {
    code,
    ...(detail.dependencyPath === undefined ? {} : { dependencyPath: Object.freeze([...detail.dependencyPath]) }),
    kind: 'flight-package-eligibility' as const,
    ...(detail.requiredEnvironment === undefined ? {} : { requiredEnvironment: detail.requiredEnvironment }),
    ...(detail.selectedEnvironment === undefined ? {} : { selectedEnvironment: detail.selectedEnvironment }),
    subject,
  });
  failure.name = 'FlightPackageEligibilityError';
  return failure;
}

function isFlightPackageEligibilityPackage(value: unknown): value is FlightPackageEligibilityPackage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    'dependencies' in value &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every((dependency: unknown) => typeof dependency === 'string' && dependency.length > 0) &&
    new Set(value.dependencies).size === value.dependencies.length &&
    (!('environment' in value) || value.environment === undefined || isFlightPackageEnvironment(value.environment))
  );
}

function isFlightPackageEnvironment(value: unknown): value is FlightPackageEnvironment {
  return typeof value === 'string' && flightPackageEnvironments.has(value as FlightPackageEnvironment);
}

const flightPackageEligibilityFailureCodes = new Set<FlightPackageEligibilityFailureCode>([
  'duplicate-package',
  'ineligible-package-environment',
  'invalid-environment',
  'invalid-package',
  'invalid-selection',
  'unknown-package',
]);

const flightPackageEnvironments = new Set<FlightPackageEnvironment>(['capacitor', 'electron', 'node', 'tauri', 'web']);

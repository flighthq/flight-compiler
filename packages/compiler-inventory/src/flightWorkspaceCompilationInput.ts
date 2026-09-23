import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  CompilerModuleResolutionEdge,
  CreateFlightWorkspaceCompilationInputOptions,
  FlightPackageManifest,
  FlightWorkspaceCompilationFailure,
  FlightWorkspaceCompilationFailureCode,
  FlightWorkspaceCompilationInput,
  PackageExportDescriptor,
  PackageImportRecord,
  TypeScriptPackageGraphSource,
  WorkspaceSource,
} from '../../compiler-types/src/index.js';
import { createFileSystemWorkspaceSource } from './fileSystemWorkspaceSource.js';
import { readPackageExportManifest } from './flightPackageExportManifest.js';
import { analyzeFlightPackageImports } from './flightPackageImport.js';
import { readFlightPackageManifests } from './flightPackageManifest.js';

interface FlightWorkspaceCompilationPackage {
  readonly exportDescriptors: readonly PackageExportDescriptor[];
  readonly manifest: Readonly<FlightPackageManifest>;
  readonly packageRoot: string;
  readonly sources: readonly FlightWorkspaceCompilationSource[];
}

interface FlightWorkspaceCompilationSource {
  readonly identity: CompilerModuleIdentity;
  readonly input: TypeScriptPackageGraphSource;
}

interface FlightWorkspaceCompilationImports {
  readonly dependencies: readonly CompilerModuleLinkDependency[];
  readonly resolutionEdges: readonly CompilerModuleResolutionEdge[];
}

export function createFlightWorkspaceCompilationInput(
  options: Readonly<CreateFlightWorkspaceCompilationInputOptions>,
): FlightWorkspaceCompilationInput {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const portableUpstreamDirectory = normalizePathPortable(upstreamDirectory);
  const packageScope = options.packageScope ?? '@flighthq';
  const workspace = options.source ?? createFileSystemWorkspaceSource();
  const manifests = readFlightPackageManifests(options, workspace);
  const manifestsByName = new Map(manifests.map((manifest) => [manifest.name, manifest] as const));
  const eligiblePackageNames = validateEligiblePackageNames(options.eligiblePackageNames, manifestsByName);
  const eligiblePackageNameSet = new Set(eligiblePackageNames);
  const packages = eligiblePackageNames.map((name): FlightWorkspaceCompilationPackage => {
    const manifest = manifestsByName.get(name)!;
    validateFlightWorkspacePackageClosure(manifest, manifestsByName, eligiblePackageNameSet, packageScope);
    const packageRoot = path.resolve(upstreamDirectory, manifest.directory);
    const sources = readFlightWorkspaceCompilationSources(
      manifest,
      packageRoot,
      upstreamDirectory,
      portableUpstreamDirectory,
      workspace,
    );
    return {
      exportDescriptors: readPackageExportManifest(packageRoot, workspace, upstreamDirectory),
      manifest,
      packageRoot,
      sources,
    };
  });
  const sourcesByPath = new Map(
    packages.flatMap((package_) => package_.sources.map((source) => [source.identity.source, source] as const)),
  );
  const exportTargets = createFlightWorkspaceExportTargets(packages, sourcesByPath);
  const imports = createFlightWorkspaceModuleDependencies(
    packages,
    sourcesByPath,
    exportTargets,
    upstreamDirectory,
    workspace,
  );
  const entries = deduplicateFlightWorkspaceModuleIdentities(
    [...exportTargets.values()].map(({ identity }) => identity),
  );
  const graphPackages = packages.map(({ manifest, packageRoot }) => ({
    dependencies: manifest.dependencies
      .filter((dependency) => eligiblePackageNameSet.has(dependency))
      .sort(compareTextCodeUnits),
    name: manifest.name,
    root: normalizePathPortable(packageRoot),
  }));
  const globalResolutionEdges = [...exportTargets.entries()].map(
    ([specifier, target]): CompilerModuleResolutionEdge => ({
      specifier,
      target: { packageName: target.identity.packageName, source: target.identity.source },
    }),
  );
  const sources = packages.flatMap((package_) => package_.sources.map(({ input }) => input));
  return freezeFlightWorkspaceCompilationInput({
    graph: {
      entries,
      moduleDependencies: imports.dependencies,
      packages: graphPackages,
      schema: 'flight-compiler-package-graph/1',
    },
    moduleResolution: {
      edges: [...globalResolutionEdges, ...imports.resolutionEdges].sort(compareFlightWorkspaceModuleResolutionEdges),
      schema: 'flight-compiler-module-resolution/1',
    },
    sources: sources.sort(compareFlightWorkspaceCompilationSources),
  });
}

export function isFlightWorkspaceCompilationFailure(value: unknown): value is FlightWorkspaceCompilationFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'flight-workspace-compilation' &&
    'code' in value &&
    flightWorkspaceCompilationFailureCodes.has(value.code as FlightWorkspaceCompilationFailureCode) &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0
  );
}

function cloneFlightWorkspaceModuleIdentity(identity: Readonly<CompilerModuleIdentity>): CompilerModuleIdentity {
  return { name: identity.name, packageName: identity.packageName, source: identity.source };
}

function compareFlightWorkspaceCompilationSources(
  left: Readonly<TypeScriptPackageGraphSource>,
  right: Readonly<TypeScriptPackageGraphSource>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.sourceFile.fileName, right.sourceFile.fileName)
  );
}

function compareFlightWorkspaceModuleIdentities(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.name, right.name)
  );
}

function compareFlightWorkspaceModuleResolutionEdges(
  left: Readonly<CompilerModuleResolutionEdge>,
  right: Readonly<CompilerModuleResolutionEdge>,
): number {
  if (left.importer === undefined && right.importer !== undefined) return -1;
  if (left.importer !== undefined && right.importer === undefined) return 1;
  return (
    (left.importer && right.importer ? compareFlightWorkspaceModuleIdentities(left.importer, right.importer) : 0) ||
    compareTextCodeUnits(left.specifier, right.specifier) ||
    compareTextCodeUnits(left.target.packageName, right.target.packageName) ||
    compareTextCodeUnits(left.target.source, right.target.source)
  );
}

function createFlightWorkspaceCompilationFailure(
  code: FlightWorkspaceCompilationFailureCode,
  subject: string,
  message: string,
): FlightWorkspaceCompilationFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'flight-workspace-compilation' as const,
    subject,
  });
  failure.name = 'FlightWorkspaceCompilationError';
  return failure;
}

function createFlightWorkspaceExportTargets(
  packages: readonly Readonly<FlightWorkspaceCompilationPackage>[],
  sourcesByPath: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
): Map<string, FlightWorkspaceCompilationSource> {
  const targets = new Map<string, FlightWorkspaceCompilationSource>();
  for (const package_ of packages) {
    for (const descriptor of package_.exportDescriptors) {
      const target = sourcesByPath.get(normalizePathPortable(descriptor.source));
      if (!target || target.identity.packageName !== package_.manifest.name) {
        throw createFlightWorkspaceCompilationFailure(
          'unresolved-export-source',
          descriptor.specifier,
          `Package export ${descriptor.specifier} does not resolve to an eligible production TypeScript source`,
        );
      }
      if (targets.has(descriptor.specifier)) {
        throw createFlightWorkspaceCompilationFailure(
          'unresolved-export-source',
          descriptor.specifier,
          `Package export specifier is duplicated: ${descriptor.specifier}`,
        );
      }
      targets.set(descriptor.specifier, target);
    }
  }
  return new Map([...targets].sort((left, right) => compareTextCodeUnits(left[0], right[0])));
}

function createFlightWorkspaceModuleDependencies(
  packages: readonly Readonly<FlightWorkspaceCompilationPackage>[],
  sourcesByPath: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
  exportTargets: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
  upstreamDirectory: string,
  workspace: WorkspaceSource,
): FlightWorkspaceCompilationImports {
  const dependencies = new Map<string, CompilerModuleLinkDependency>();
  const resolutionEdges = new Map<string, CompilerModuleResolutionEdge>();
  for (const package_ of packages) {
    const imports = analyzeFlightPackageImports({ manifest: package_.manifest, upstreamDirectory }, workspace);
    for (const imported of imports) {
      const importer = sourcesByPath.get(normalizePathPortable(imported.source));
      if (!importer || importer.identity.packageName !== package_.manifest.name) {
        throw createFlightWorkspaceCompilationFailure(
          'invalid-source-path',
          imported.source,
          `Package import names an unknown production source: ${imported.source}`,
        );
      }
      const target = resolveFlightWorkspaceImport(imported, importer, sourcesByPath, exportTargets);
      if (
        target.identity.packageName !== importer.identity.packageName &&
        !package_.manifest.dependencies.includes(target.identity.packageName)
      ) {
        throw createFlightWorkspaceCompilationFailure(
          'incomplete-package-closure',
          `${package_.manifest.name}:${target.identity.packageName}`,
          `Package ${package_.manifest.name} imports undeclared package ${target.identity.packageName}`,
        );
      }
      const resolutionEdge: CompilerModuleResolutionEdge = {
        importer: cloneFlightWorkspaceModuleIdentity(importer.identity),
        specifier: imported.specifier,
        target: { packageName: target.identity.packageName, source: target.identity.source },
      };
      resolutionEdges.set(
        JSON.stringify([
          resolutionEdge.importer?.packageName,
          resolutionEdge.importer?.source,
          resolutionEdge.importer?.name,
          resolutionEdge.specifier,
          resolutionEdge.target.packageName,
          resolutionEdge.target.source,
        ]),
        resolutionEdge,
      );
      if (imported.kind === 'dynamic') continue;
      const dependency: CompilerModuleLinkDependency = {
        importer: cloneFlightWorkspaceModuleIdentity(importer.identity),
        specifier: imported.specifier,
        target: cloneFlightWorkspaceModuleIdentity(target.identity),
      };
      const key = JSON.stringify([
        dependency.importer.packageName,
        dependency.importer.source,
        dependency.importer.name,
        dependency.specifier,
        dependency.target.packageName,
        dependency.target.source,
        dependency.target.name,
      ]);
      dependencies.set(key, dependency);
    }
  }
  return {
    dependencies: [...dependencies.values()].sort(
      (left, right) =>
        compareFlightWorkspaceModuleIdentities(left.importer, right.importer) ||
        compareTextCodeUnits(left.specifier, right.specifier) ||
        compareFlightWorkspaceModuleIdentities(left.target, right.target),
    ),
    resolutionEdges: [...resolutionEdges.values()].sort(compareFlightWorkspaceModuleResolutionEdges),
  };
}

function deduplicateFlightWorkspaceModuleIdentities(
  identities: readonly Readonly<CompilerModuleIdentity>[],
): CompilerModuleIdentity[] {
  const deduplicated = new Map(
    identities.map((identity) => [JSON.stringify([identity.packageName, identity.source, identity.name]), identity]),
  );
  return [...deduplicated.values()]
    .sort(compareFlightWorkspaceModuleIdentities)
    .map(cloneFlightWorkspaceModuleIdentity);
}

function freezeFlightWorkspaceCompilationInput(
  input: Readonly<FlightWorkspaceCompilationInput>,
): FlightWorkspaceCompilationInput {
  const graph = Object.freeze({
    entries: Object.freeze(input.graph.entries.map((entry) => Object.freeze({ ...entry }))),
    moduleDependencies: Object.freeze(
      input.graph.moduleDependencies.map((dependency) =>
        Object.freeze({
          importer: Object.freeze({ ...dependency.importer }),
          specifier: dependency.specifier,
          target: Object.freeze({ ...dependency.target }),
        }),
      ),
    ),
    packages: Object.freeze(
      input.graph.packages.map((package_) =>
        Object.freeze({ ...package_, dependencies: Object.freeze([...package_.dependencies]) }),
      ),
    ),
    schema: input.graph.schema,
  });
  const moduleResolution = Object.freeze({
    edges: Object.freeze(
      input.moduleResolution.edges.map((edge) =>
        Object.freeze({
          ...(edge.importer ? { importer: Object.freeze({ ...edge.importer }) } : {}),
          ...(edge.importedNames ? { importedNames: Object.freeze([...edge.importedNames]) } : {}),
          specifier: edge.specifier,
          target: Object.freeze({ ...edge.target }),
        }),
      ),
    ),
    schema: input.moduleResolution.schema,
  });
  const sources = Object.freeze(input.sources.map((source) => Object.freeze({ ...source })));
  return Object.freeze({ graph, moduleResolution, sources });
}

function getFlightWorkspaceModuleName(source: string): string {
  const name = path.posix.basename(source).replace(/\.tsx?$/u, '');
  return name === 'index' ? 'Index' : `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function readFlightWorkspaceCompilationSources(
  manifest: Readonly<FlightPackageManifest>,
  packageRoot: string,
  upstreamDirectory: string,
  portableUpstreamDirectory: string,
  workspace: WorkspaceSource,
): FlightWorkspaceCompilationSource[] {
  const sourceDirectory = path.join(packageRoot, 'src');
  if (!workspace.isDirectory(sourceDirectory)) {
    throw createFlightWorkspaceCompilationFailure(
      'missing-package-sources',
      manifest.name,
      `Eligible package ${manifest.name} has no source directory`,
    );
  }
  const files = walkFlightWorkspaceProductionSources(sourceDirectory, workspace);
  if (files.length === 0) {
    throw createFlightWorkspaceCompilationFailure(
      'missing-package-sources',
      manifest.name,
      `Eligible package ${manifest.name} has no production TypeScript sources`,
    );
  }
  return files.map((file) => {
    const portableFile = normalizePathPortable(file);
    const source = relativeFlightWorkspacePath(file, upstreamDirectory);
    return {
      identity: { name: getFlightWorkspaceModuleName(source), packageName: manifest.name, source },
      input: {
        packageName: manifest.name,
        packageRoot: normalizePathPortable(packageRoot),
        sourceFile: ts.createSourceFile(
          portableFile,
          workspace.readTextFile(file).replace(/^\uFEFF/u, ''),
          ts.ScriptTarget.Latest,
          true,
          file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
        upstreamDirectory: portableUpstreamDirectory,
      },
    };
  });
}

function relativeFlightWorkspacePath(target: string, upstreamDirectory: string): string {
  const relative = path.relative(upstreamDirectory, path.resolve(target));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createFlightWorkspaceCompilationFailure(
      'invalid-source-path',
      normalizePathPortable(target),
      `Workspace source is outside the Flight checkout: ${normalizePathPortable(target)}`,
    );
  }
  return normalizePathPortable(relative);
}

function resolveFlightWorkspaceImport(
  imported: Readonly<PackageImportRecord>,
  importer: Readonly<FlightWorkspaceCompilationSource>,
  sourcesByPath: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
  exportTargets: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
): FlightWorkspaceCompilationSource {
  const target = imported.specifier.startsWith('.')
    ? resolveFlightWorkspaceRelativeImport(imported, importer, sourcesByPath)
    : exportTargets.get(imported.specifier);
  if (!target) {
    throw createFlightWorkspaceCompilationFailure(
      'unresolved-import',
      `${imported.source}:${imported.specifier}`,
      `Cannot resolve workspace import ${imported.specifier} from ${imported.source}`,
    );
  }
  return target;
}

function resolveFlightWorkspaceRelativeImport(
  imported: Readonly<PackageImportRecord>,
  importer: Readonly<FlightWorkspaceCompilationSource>,
  sourcesByPath: ReadonlyMap<string, Readonly<FlightWorkspaceCompilationSource>>,
): FlightWorkspaceCompilationSource | undefined {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(imported.source), imported.specifier));
  const candidates = new Set([unresolved]);
  for (const [emitted, source] of [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const) {
    if (unresolved.endsWith(emitted)) candidates.add(`${unresolved.slice(0, -emitted.length)}${source}`);
  }
  if (!/\.[^/]+$/u.test(unresolved)) {
    candidates.add(`${unresolved}.ts`);
    candidates.add(`${unresolved}.tsx`);
    candidates.add(`${unresolved}/index.ts`);
    candidates.add(`${unresolved}/index.tsx`);
  }
  const matches = [...candidates]
    .map((candidate) => sourcesByPath.get(normalizePathPortable(candidate)))
    .filter(
      (candidate): candidate is FlightWorkspaceCompilationSource =>
        candidate !== undefined && candidate.identity.packageName === importer.identity.packageName,
    );
  return matches.length === 1 ? matches[0] : undefined;
}

function validateEligiblePackageNames(
  eligiblePackageNames: readonly string[],
  manifestsByName: ReadonlyMap<string, Readonly<FlightPackageManifest>>,
): string[] {
  if (eligiblePackageNames.length === 0) {
    throw createFlightWorkspaceCompilationFailure(
      'empty-eligible-package-set',
      'eligiblePackageNames',
      'Flight workspace compilation requires an explicit nonempty eligible package closure',
    );
  }
  const names = new Set<string>();
  for (const name of eligiblePackageNames) {
    if (names.has(name)) {
      throw createFlightWorkspaceCompilationFailure(
        'duplicate-eligible-package',
        name,
        `Eligible Flight package is duplicated: ${name}`,
      );
    }
    if (!manifestsByName.has(name)) {
      throw createFlightWorkspaceCompilationFailure(
        'unknown-eligible-package',
        name,
        `Eligible Flight package does not exist in the workspace: ${name}`,
      );
    }
    names.add(name);
  }
  return [...names].sort(compareTextCodeUnits);
}

function validateFlightWorkspacePackageClosure(
  manifest: Readonly<FlightPackageManifest>,
  manifestsByName: ReadonlyMap<string, Readonly<FlightPackageManifest>>,
  eligiblePackageNames: ReadonlySet<string>,
  packageScope: string,
): void {
  for (const dependency of manifest.dependencies) {
    if (!manifestsByName.has(dependency) && !dependency.startsWith(`${packageScope}/`)) continue;
    if (eligiblePackageNames.has(dependency)) continue;
    throw createFlightWorkspaceCompilationFailure(
      'incomplete-package-closure',
      `${manifest.name}:${dependency}`,
      `Eligible package closure omits ${dependency}, required by ${manifest.name}`,
    );
  }
}

function walkFlightWorkspaceProductionSources(directory: string, workspace: WorkspaceSource): string[] {
  const files: string[] = [];
  for (const entry of [...workspace.listDirectory(directory)].sort((left, right) =>
    compareTextCodeUnits(left.name, right.name),
  )) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory) {
      files.push(...walkFlightWorkspaceProductionSources(target, workspace));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.(?:test|spec)\.tsx?$/u.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(target);
    }
  }
  return files.sort(compareTextCodeUnits);
}

const flightWorkspaceCompilationFailureCodes = new Set<FlightWorkspaceCompilationFailureCode>([
  'duplicate-eligible-package',
  'empty-eligible-package-set',
  'incomplete-package-closure',
  'invalid-source-path',
  'missing-package-sources',
  'unknown-eligible-package',
  'unresolved-export-source',
  'unresolved-import',
]);

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import {
  createCompilerInvariantFailure,
  isBackendEmissionFailure,
  isCompilerInvariantFailure,
  normalizeEmittedFile,
  validateCompilerEmittedSourceSyntax,
  validateCompilerTargetCompilationSmoke,
} from '../../compiler-emission/src/index.js';
import {
  createCompilerModuleEvaluationPlan,
  isCompilerModuleEvaluationFailure,
} from '../../compiler-module/src/index.js';
import { applySemanticPatchSet } from '../../compiler-patch/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompileTypeScriptPackageGraphOptions,
  CompilerDiagnostic,
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  CompilerModuleResolutionPlan,
  CompilerPackageCompilationFileReport,
  CompilerPackageCompilationModuleReport,
  CompilerPackageCompilationRefusal,
  CompilerPackageCompilationResult,
  CompilerPackageGraphFailure,
  CompilerPackageGraphFailureCode,
  CompilerPackageGraphPackage,
  EmittedFile,
  IrModule,
} from '../../compiler-types/src/index.js';

interface ModuleEmissionRecord {
  readonly files: EmittedFile[];
  readonly module: IrModule;
  readonly refusals: CompilerPackageCompilationRefusal[];
}

export function compileTypeScriptPackageGraph<BackendOptions>(
  options: Readonly<CompileTypeScriptPackageGraphOptions<BackendOptions>>,
): CompilerPackageCompilationResult {
  const packages = validateCompilerPackageGraphPackages(options.graph, options.sources);
  const lowered = options.sources.map(({ packageRoot: _packageRoot, sourceFile, ...loweringOptions }) =>
    lowerTypeScriptSource(sourceFile, loweringOptions),
  );
  validateCompilerPackageGraphModuleIdentities(lowered.map((result) => result.module));
  validateCompilerPackageGraphReferences(options.graph.entries, options.graph.moduleDependencies, lowered, packages);
  const patched = applySemanticPatchSet(
    lowered.map((result) => result.module),
    options.patches ?? [],
    options.backend.name,
  );
  const modules = [...patched.modules].sort(compareCompilerPackageGraphModules);
  const graphEntries =
    options.graph.entries.length > 0
      ? options.graph.entries
      : modules.map(cloneCompilerPackageGraphIdentity).sort(compareCompilerPackageGraphModules);
  const moduleDependencies = createCompilerPackageGraphModuleDependencies(
    modules,
    options.graph.moduleDependencies,
    options.moduleResolution,
  );
  validateCompilerPackageGraphReferences(graphEntries, moduleDependencies, lowered, packages);
  const records = new Map<string, ModuleEmissionRecord>(
    modules.map((module) => [
      getCompilerPackageGraphModuleKey(module),
      { files: [], module, refusals: [] } satisfies ModuleEmissionRecord,
    ]),
  );
  const diagnostics = lowered.flatMap((result) => result.diagnostics).sort(compareCompilerPackageGraphDiagnostics);
  for (const diagnostic of diagnostics) {
    const record = [...records.values()].find(
      (candidate) =>
        candidate.module.packageName === diagnostic.packageName && candidate.module.source === diagnostic.source,
    );
    if (!record) continue;
    record.refusals.push({
      code: diagnostic.code,
      column: diagnostic.column,
      line: diagnostic.line,
      message: diagnostic.message,
      stage: 'lowering',
    });
  }
  propagateCompilerPackageGraphRefusals(records, moduleDependencies);

  const emissionModules = modules.filter(
    (module) => records.get(getCompilerPackageGraphModuleKey(module))!.refusals.length === 0,
  );
  const moduleResolution = createCompilerPackageGraphModuleResolution(moduleDependencies, options.moduleResolution);
  const emitContext = {
    moduleResolution,
    modules: emissionModules,
    options: options.backendOptions,
  };
  const emissionSession = options.backend.createEmissionSession?.(emitContext);
  for (const module of emissionModules) {
    const record = records.get(getCompilerPackageGraphModuleKey(module))!;
    try {
      record.files.push(
        ...(emissionSession ? emissionSession.emitModule(module) : options.backend.emitModule(module, emitContext)).map(
          normalizeEmittedFile,
        ),
      );
    } catch (error) {
      record.refusals.push(createCompilerPackageGraphEmissionRefusal(error));
    }
  }
  refuseCompilerPackageGraphOutputCollisions(records);
  propagateCompilerPackageGraphRefusals(records, moduleDependencies);
  const initialization = createCompilerPackageGraphInitialization(records, graphEntries, moduleDependencies);
  propagateCompilerPackageGraphRefusals(records, moduleDependencies);

  const files = [...records.values()]
    .filter((record) => record.refusals.length === 0)
    .flatMap((record) => record.files)
    .sort(compareCompilerPackageGraphFiles);
  validateCompilerPackageGraphOutput(files, options);
  const moduleReports = createCompilerPackageGraphModuleReports(records);
  const fileReports = createCompilerPackageGraphFileReports(records);
  return {
    compilation: { backend: options.backend.name, files },
    diagnostics,
    patchAudit: patched.audit,
    report: {
      backend: options.backend.name,
      entries: graphEntries.map(cloneCompilerPackageGraphIdentity).sort(compareCompilerPackageGraphModules),
      files: fileReports,
      initialization,
      modules: moduleReports,
      packages: [...packages.values()].sort(compareCompilerPackageGraphPackages).map((package_) => {
        const packageModules = moduleReports.filter((report) => report.module.packageName === package_.name);
        return {
          dependencies: [...package_.dependencies].sort(compareTextCodeUnits),
          modules: packageModules,
          name: package_.name,
          outputFiles: packageModules.flatMap((module) => module.outputFiles).sort(compareTextCodeUnits),
        };
      }),
      schema: 'flight-compiler-package-report/1',
    },
  };
}

export function isCompilerPackageGraphFailure(value: unknown): value is CompilerPackageGraphFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-package-graph' &&
    'code' in value &&
    compilerPackageGraphFailureCodes.has(value.code as CompilerPackageGraphFailureCode) &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0
  );
}

function cloneCompilerPackageGraphIdentity(identity: Readonly<CompilerModuleIdentity>): CompilerModuleIdentity {
  return { name: identity.name, packageName: identity.packageName, source: identity.source };
}

function compareCompilerPackageGraphDiagnostics(
  left: Readonly<CompilerDiagnostic>,
  right: Readonly<CompilerDiagnostic>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    left.line - right.line ||
    left.column - right.column ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

function compareCompilerPackageGraphFiles(left: Readonly<EmittedFile>, right: Readonly<EmittedFile>): number {
  return compareTextCodeUnits(left.path, right.path);
}

function compareCompilerPackageGraphModules(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.name, right.name)
  );
}

function compareCompilerPackageGraphPackages(
  left: Readonly<CompilerPackageGraphPackage>,
  right: Readonly<CompilerPackageGraphPackage>,
): number {
  return compareTextCodeUnits(left.name, right.name);
}

function compareCompilerPackageGraphRefusals(
  left: Readonly<CompilerPackageCompilationRefusal>,
  right: Readonly<CompilerPackageCompilationRefusal>,
): number {
  return (
    compareTextCodeUnits(left.stage, right.stage) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

function createCompilerPackageGraphEmissionRefusal(error: unknown): CompilerPackageCompilationRefusal {
  if (isBackendEmissionFailure(error)) {
    return { code: error.code, message: error.message, stage: 'emission' };
  }
  if (isCompilerInvariantFailure(error)) {
    return { code: error.code, message: error.message, stage: 'emission' };
  }
  if (error instanceof Error) {
    return { code: 'internal-error', message: error.message, stage: 'emission' };
  }
  throw error;
}

function createCompilerPackageGraphFailure(
  code: CompilerPackageGraphFailureCode,
  subject: string,
  message: string,
): CompilerPackageGraphFailure {
  const failure = Object.assign(new Error(message), { code, kind: 'compiler-package-graph' as const, subject });
  failure.name = 'CompilerPackageGraphError';
  return failure;
}

function createCompilerPackageGraphFileReports(
  records: ReadonlyMap<string, Readonly<ModuleEmissionRecord>>,
): CompilerPackageCompilationFileReport[] {
  return [...records.values()]
    .filter((record) => record.refusals.length === 0)
    .flatMap((record) =>
      record.files.map((file) => ({
        dependencies: [...(file.dependencies ?? [])],
        module: cloneCompilerPackageGraphIdentity(record.module),
        path: file.path,
      })),
    )
    .sort((left, right) => compareTextCodeUnits(left.path, right.path));
}

function createCompilerPackageGraphInitialization(
  records: Map<string, ModuleEmissionRecord>,
  entries: readonly Readonly<CompilerModuleIdentity>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
) {
  for (;;) {
    const availableKeys = new Set(
      [...records].filter(([, record]) => record.refusals.length === 0).map(([key]) => key),
    );
    const availableEntries = entries.filter((entry) => availableKeys.has(getCompilerPackageGraphModuleKey(entry)));
    const reachableKeys = collectCompilerPackageGraphReachableKeys(availableEntries, dependencies, availableKeys);
    const reachableModules = [...records]
      .filter(([key]) => reachableKeys.has(key))
      .map(([, record]) => record.module)
      .sort(compareCompilerPackageGraphModules);
    const reachableDependencies = dependencies.filter(
      (dependency) =>
        reachableKeys.has(getCompilerPackageGraphModuleKey(dependency.importer)) &&
        reachableKeys.has(getCompilerPackageGraphModuleKey(dependency.target)),
    );
    try {
      return createCompilerModuleEvaluationPlan({
        dependencies: reachableDependencies,
        entries: availableEntries.map(cloneCompilerPackageGraphIdentity).sort(compareCompilerPackageGraphModules),
        modules: reachableModules,
      });
    } catch (error) {
      if (!isCompilerModuleEvaluationFailure(error) || !error.module) throw error;
      const record = records.get(getCompilerPackageGraphModuleKey(error.module));
      if (!record || record.refusals.length > 0) throw error;
      record.refusals.push({ code: error.code, message: error.message, stage: 'initialization' });
      record.files.splice(0);
      propagateCompilerPackageGraphRefusals(records, dependencies);
    }
  }
}

function createCompilerPackageGraphModuleReports(
  records: ReadonlyMap<string, Readonly<ModuleEmissionRecord>>,
): CompilerPackageCompilationModuleReport[] {
  return [...records.values()]
    .sort((left, right) => compareCompilerPackageGraphModules(left.module, right.module))
    .map((record) => ({
      module: cloneCompilerPackageGraphIdentity(record.module),
      outputFiles: record.refusals.length === 0 ? record.files.map((file) => file.path).sort(compareTextCodeUnits) : [],
      refusals: [...record.refusals].sort(compareCompilerPackageGraphRefusals),
      status: record.refusals.length === 0 ? ('emitted' as const) : ('refused' as const),
    }));
}

function createCompilerPackageGraphModuleDependencies(
  modules: readonly Readonly<IrModule>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  resolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
): CompilerModuleLinkDependency[] {
  const dependencyByRequest = new Map(
    dependencies.map((dependency) => [
      `${getCompilerPackageGraphModuleKey(dependency.importer)}\0${dependency.specifier}`,
      dependency,
    ]),
  );
  for (const module of modules) {
    const specifiers = new Set([
      ...module.imports.map((imported) => imported.specifier),
      ...module.exports.flatMap((exported) =>
        exported.kind === 'all' || exported.kind === 'namespace' || exported.kind === 'reexport'
          ? [exported.specifier]
          : [],
      ),
    ]);
    for (const specifier of specifiers) {
      const key = `${getCompilerPackageGraphModuleKey(module)}\0${specifier}`;
      if (dependencyByRequest.has(key)) continue;
      const target = resolveCompilerPackageGraphModule(module, specifier, modules, resolution);
      if (!target) continue;
      dependencyByRequest.set(key, {
        importer: cloneCompilerPackageGraphIdentity(module),
        specifier,
        target: cloneCompilerPackageGraphIdentity(target),
      });
    }
  }
  return [...dependencyByRequest.values()].sort(
    (left, right) =>
      compareCompilerPackageGraphModules(left.importer, right.importer) ||
      compareTextCodeUnits(left.specifier, right.specifier) ||
      compareCompilerPackageGraphModules(left.target, right.target),
  );
}

function createCompilerPackageGraphModuleResolution(
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  resolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
): CompilerModuleResolutionPlan {
  return {
    edges: [
      ...(resolution?.edges ?? []),
      ...dependencies.map((dependency) => ({
        importer: cloneCompilerPackageGraphIdentity(dependency.importer),
        specifier: dependency.specifier,
        target: {
          packageName: dependency.target.packageName,
          source: dependency.target.source,
        },
      })),
    ],
    schema: 'flight-compiler-module-resolution/1',
  };
}

function collectCompilerPackageGraphReachableKeys(
  entries: readonly Readonly<CompilerModuleIdentity>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  availableKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const byImporter = new Map<string, CompilerModuleIdentity[]>();
  for (const dependency of dependencies) {
    const importerKey = getCompilerPackageGraphModuleKey(dependency.importer);
    if (!availableKeys.has(importerKey) || !availableKeys.has(getCompilerPackageGraphModuleKey(dependency.target))) {
      continue;
    }
    byImporter.set(importerKey, [...(byImporter.get(importerKey) ?? []), dependency.target]);
  }
  const reachable = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const identity = pending.pop()!;
    const key = getCompilerPackageGraphModuleKey(identity);
    if (reachable.has(key)) continue;
    reachable.add(key);
    pending.push(...(byImporter.get(key) ?? []));
  }
  return reachable;
}

function getCompilerPackageGraphModuleKey(identity: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([identity.packageName, normalizePathPortable(identity.source), identity.name]);
}

function propagateCompilerPackageGraphRefusals(
  records: Map<string, ModuleEmissionRecord>,
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
): void {
  const ordered = [...dependencies].sort(
    (left, right) =>
      compareCompilerPackageGraphModules(left.importer, right.importer) ||
      compareTextCodeUnits(left.specifier, right.specifier) ||
      compareCompilerPackageGraphModules(left.target, right.target),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of ordered) {
      const importer = records.get(getCompilerPackageGraphModuleKey(dependency.importer));
      const target = records.get(getCompilerPackageGraphModuleKey(dependency.target));
      if (!importer || !target || importer.refusals.length > 0 || target.refusals.length === 0) continue;
      importer.refusals.push({
        code: 'dependency-refused',
        message: `dependency ${dependency.specifier} was refused for ${dependency.target.packageName}/${dependency.target.source}`,
        stage: 'dependency',
      });
      importer.files.splice(0);
      changed = true;
    }
  }
}

function refuseCompilerPackageGraphOutputCollisions(records: Map<string, ModuleEmissionRecord>): void {
  const owners = new Map<string, ModuleEmissionRecord[]>();
  for (const record of records.values()) {
    if (record.refusals.length > 0) continue;
    for (const file of record.files) {
      const key = file.path.normalize('NFC').toLowerCase();
      owners.set(key, [...(owners.get(key) ?? []), record]);
    }
  }
  for (const [path, colliding] of owners) {
    if (colliding.length < 2) continue;
    const message = `Backend emitted colliding package file path: ${path}`;
    for (const record of colliding) {
      record.refusals.push({ code: 'duplicate-emitted-path', message, stage: 'emission' });
      record.files.splice(0);
    }
  }
}

function resolveCompilerPackageGraphModule(
  importer: Readonly<IrModule>,
  specifier: string,
  modules: readonly Readonly<IrModule>[],
  resolution?: Readonly<CompilerModuleResolutionPlan> | undefined,
): Readonly<IrModule> | undefined {
  const matching = resolution?.edges.filter((edge) => edge.specifier === specifier) ?? [];
  const exact = matching.filter(
    (edge) =>
      edge.importer && getCompilerPackageGraphModuleKey(edge.importer) === getCompilerPackageGraphModuleKey(importer),
  );
  const targets = exact.length > 0 ? exact : matching.filter((edge) => !edge.importer);
  const resolved = targets.flatMap((edge) =>
    modules.filter(
      (module) =>
        module.packageName === edge.target.packageName &&
        normalizePathPortable(module.source) === normalizePathPortable(edge.target.source),
    ),
  );
  if (resolved.length === 1) return resolved[0];
  if (!specifier.startsWith('.')) return undefined;
  const sourceParts = normalizePathPortable(importer.source).split('/');
  sourceParts.pop();
  for (const part of normalizePathPortable(specifier).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') sourceParts.pop();
    else sourceParts.push(part);
  }
  const unresolved = sourceParts.join('/');
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
    candidates.add(`${unresolved}/index.ts`);
  }
  const local = modules.filter(
    (module) => module.packageName === importer.packageName && candidates.has(normalizePathPortable(module.source)),
  );
  return local.length === 1 ? local[0] : undefined;
}

function validateCompilerPackageGraphModuleIdentities(modules: readonly Readonly<IrModule>[]): void {
  const identities = new Set<string>();
  for (const module of modules) {
    const key = getCompilerPackageGraphModuleKey(module);
    if (identities.has(key)) {
      throw createCompilerInvariantFailure(
        'duplicate-module-identity',
        key,
        `Duplicate compiler module identity: ${module.packageName}/${module.source}#${module.name}`,
      );
    }
    identities.add(key);
  }
}

function validateCompilerPackageGraphOutput<BackendOptions>(
  files: readonly Readonly<EmittedFile>[],
  options: Readonly<CompileTypeScriptPackageGraphOptions<BackendOptions>>,
): void {
  if (options.sourceParser) {
    const syntax = validateCompilerEmittedSourceSyntax(files, options.sourceParser);
    if (files.length > 0 && syntax.checkedFiles === 0) {
      throw createCompilerInvariantFailure(
        'insufficient-emitted-source-syntax-files',
        syntax.parser,
        `Emitted-source parser ${syntax.parser} did not support any of ${String(files.length)} emitted file(s)`,
      );
    }
  }
  if (options.targetCompilationSmoke) {
    const smoke = validateCompilerTargetCompilationSmoke(files, options.targetCompilationSmoke);
    if (files.length > 0 && smoke.checkedFiles === 0) {
      throw createCompilerInvariantFailure(
        'insufficient-target-compilation-smoke-files',
        smoke.compiler,
        `Target compiler ${smoke.compiler} did not support any of ${String(files.length)} emitted file(s)`,
      );
    }
  }
}

function validateCompilerPackageGraphPackages(
  graph: Readonly<CompileTypeScriptPackageGraphOptions<unknown>['graph']>,
  sources: readonly Readonly<CompileTypeScriptPackageGraphOptions<unknown>['sources'][number]>[],
): Map<string, CompilerPackageGraphPackage> {
  if (
    !graph ||
    graph.schema !== 'flight-compiler-package-graph/1' ||
    !Array.isArray(graph.entries) ||
    !Array.isArray(graph.moduleDependencies) ||
    !Array.isArray(graph.packages)
  ) {
    throw createCompilerPackageGraphFailure(
      'invalid-graph',
      'graph',
      'Package compilation requires flight-compiler-package-graph/1',
    );
  }
  const packages = new Map<string, CompilerPackageGraphPackage>();
  for (const [index, package_] of graph.packages.entries()) {
    const subject = `packages[${String(index)}]`;
    if (
      !package_ ||
      typeof package_.name !== 'string' ||
      package_.name.length === 0 ||
      typeof package_.root !== 'string' ||
      package_.root.length === 0 ||
      !Array.isArray(package_.dependencies) ||
      package_.dependencies.some((dependency: unknown) => typeof dependency !== 'string' || dependency.length === 0)
    ) {
      throw createCompilerPackageGraphFailure(
        'invalid-package',
        subject,
        `Package graph entry is malformed at ${subject}`,
      );
    }
    if (packages.has(package_.name)) {
      throw createCompilerPackageGraphFailure(
        'duplicate-package',
        package_.name,
        `Package graph contains duplicate package ${package_.name}`,
      );
    }
    packages.set(package_.name, {
      dependencies: [...package_.dependencies],
      name: package_.name,
      root: normalizePathPortable(package_.root),
    });
  }
  for (const package_ of packages.values()) {
    const dependencies = new Set<string>();
    for (const dependency of package_.dependencies) {
      if (dependency === package_.name || dependencies.has(dependency) || !packages.has(dependency)) {
        throw createCompilerPackageGraphFailure(
          'invalid-package-dependency',
          `${package_.name}:${dependency}`,
          `Package ${package_.name} has invalid dependency ${dependency}`,
        );
      }
      dependencies.add(dependency);
    }
  }
  for (const [index, source] of sources.entries()) {
    const subject = `sources[${String(index)}]`;
    if (
      !source ||
      typeof source.packageName !== 'string' ||
      typeof source.packageRoot !== 'string' ||
      !source.sourceFile
    ) {
      throw createCompilerPackageGraphFailure('invalid-source', subject, `Package source is malformed at ${subject}`);
    }
    const package_ = packages.get(source.packageName);
    if (!package_) {
      throw createCompilerPackageGraphFailure(
        'unknown-package',
        source.packageName,
        `Package source names unknown package ${source.packageName}`,
      );
    }
    const root = normalizePathPortable(source.packageRoot);
    const sourcePath = normalizePathPortable(source.sourceFile.fileName);
    if (root !== package_.root || !sourcePath.startsWith(`${root}/`)) {
      throw createCompilerPackageGraphFailure(
        'package-root-mismatch',
        source.sourceFile.fileName,
        `Source ${source.sourceFile.fileName} is not within declared package root ${package_.root}`,
      );
    }
  }
  return packages;
}

function validateCompilerPackageGraphReferences(
  entries: readonly Readonly<CompilerModuleIdentity>[],
  dependencies: readonly Readonly<CompilerModuleLinkDependency>[],
  lowered: readonly Readonly<{ module: IrModule }>[],
  packages: ReadonlyMap<string, Readonly<CompilerPackageGraphPackage>>,
): void {
  const identities = new Set(lowered.map((result) => getCompilerPackageGraphModuleKey(result.module)));
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = getCompilerPackageGraphModuleKey(entry);
    if (!identities.has(key)) {
      throw createCompilerPackageGraphFailure(
        'invalid-entry',
        key,
        `Package graph entry does not name an input module: ${key}`,
      );
    }
    if (entryKeys.has(key)) {
      throw createCompilerPackageGraphFailure('duplicate-entry', key, `Package graph entry is duplicated: ${key}`);
    }
    entryKeys.add(key);
  }
  const dependencyKeys = new Set<string>();
  for (const dependency of dependencies) {
    const importerKey = getCompilerPackageGraphModuleKey(dependency.importer);
    const targetKey = getCompilerPackageGraphModuleKey(dependency.target);
    const dependencyKey = `${importerKey}\0${dependency.specifier}`;
    const importerPackage = packages.get(dependency.importer.packageName);
    if (
      !identities.has(importerKey) ||
      !identities.has(targetKey) ||
      typeof dependency.specifier !== 'string' ||
      dependency.specifier.length === 0 ||
      dependencyKeys.has(dependencyKey) ||
      (dependency.importer.packageName !== dependency.target.packageName &&
        !importerPackage?.dependencies.includes(dependency.target.packageName))
    ) {
      throw createCompilerPackageGraphFailure(
        'invalid-module-dependency',
        dependencyKey,
        `Package module dependency is invalid for ${dependency.importer.packageName}/${dependency.importer.source}`,
      );
    }
    dependencyKeys.add(dependencyKey);
  }
}

const compilerPackageGraphFailureCodes = new Set<CompilerPackageGraphFailureCode>([
  'duplicate-entry',
  'duplicate-package',
  'invalid-entry',
  'invalid-graph',
  'invalid-module-dependency',
  'invalid-package',
  'invalid-package-dependency',
  'invalid-source',
  'package-root-mismatch',
  'unknown-package',
]);

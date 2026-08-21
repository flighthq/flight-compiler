import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { fingerprintTypeScriptNode } from '../../compiler-provenance/src/index.js';
import type {
  AnalyzeFlightWorkspaceOptions,
  ExportConflict,
  ExportKind,
  ExportRecord,
  PackageExportDescriptor,
  PackageExportLane,
  PackageInventory,
  RuntimeExportDecision,
  RuntimeBindingRecord,
  SdkExposure,
  UpstreamInventory,
  WorkspaceSource,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { analyzeFlightPackageExclusions } from './flightPackageExclusion.js';
import { getPackageInventoryRootExportLane, resolvePackageExportLane } from './flightPackageExportLane.js';
import { readPackageExportManifest } from './flightPackageExportManifest.js';
import { analyzeFlightPackageHostFacts } from './flightPackageHostFacts.js';
import { analyzeFlightPackageImports } from './flightPackageImport.js';
import { readFlightPackageManifests } from './flightPackageManifest.js';
import { readGitCommit } from './gitCheckoutRevision.js';
import { createHostWorkspaceSource } from './hostWorkspaceSource.js';
import { createTypeScriptProject } from './typeScriptProject.js';
import { analyzeTypeScriptSourceRuntimeExports } from './typeScriptRuntimeBinding.js';

interface PackageDescriptor {
  directory: string;
  name: string;
  version: string;
}

interface ParsedSource {
  directExports: Map<string, ExportRecord>;
  exportDeclarations: ts.ExportDeclaration[];
  localDeclarations: Map<string, ExportRecord>;
  localImports: Map<string, { importedName: string; specifier: string }>;
}

interface ResolvedExportSet {
  conflicts: Map<string, Set<string>>;
  exports: Map<string, ExportRecord>;
}

type ExportCandidates = Map<string, Map<string, ExportRecord>>;

interface AnalysisContext {
  exportDescriptors: ReadonlyMap<string, PackageExportDescriptor[]>;
  packageByName: ReadonlyMap<string, PackageDescriptor>;
  parsedSources: Map<string, ParsedSource>;
  program: ts.Program;
  resolvedCandidates: Map<string, ExportCandidates>;
  resolvedExports: Map<string, ResolvedExportSet>;
  upstreamDirectory: string;
  workspaceSource: WorkspaceSource;
}

export function analyzeFlightWorkspace(options: Readonly<AnalyzeFlightWorkspaceOptions>): UpstreamInventory {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const packageScope = options.packageScope ?? '@flighthq';
  const sdkPackageName = options.sdkPackageName ?? `${packageScope}/sdk`;
  // The one place the host default is chosen; everything below takes the capability.
  const workspaceSource = options.source ?? createHostWorkspaceSource();
  const packageManifests = readFlightPackageManifests(options, workspaceSource);
  const packageManifestByName = new Map(packageManifests.map((manifest) => [manifest.name, manifest]));
  const packages = packageManifests.map(
    (manifest): PackageDescriptor => ({
      directory: path.resolve(upstreamDirectory, manifest.directory),
      name: manifest.name,
      version: manifest.version,
    }),
  );
  const project = createTypeScriptProject(path.resolve(upstreamDirectory, options.tsconfigPath ?? 'tsconfig.json'));
  const exportDescriptors = new Map(
    packages.map((descriptor) => [
      descriptor.name,
      readPackageExportManifest(descriptor.directory, workspaceSource, upstreamDirectory),
    ]),
  );
  const context: AnalysisContext = {
    exportDescriptors,
    packageByName: new Map(packages.map((item) => [item.name, item])),
    parsedSources: new Map(),
    program: project.program,
    resolvedCandidates: new Map(),
    resolvedExports: new Map(),
    upstreamDirectory,
    workspaceSource,
  };
  const packageInventories = packages.map((descriptor): PackageInventory => {
    const sourceDirectory = path.join(descriptor.directory, 'src');
    const sourceFiles = walkFiles(sourceDirectory, isSourceFile, workspaceSource);
    const testFiles = walkFiles(sourceDirectory, isTestFile, workspaceSource);
    const packageManifest = packageManifestByName.get(descriptor.name)!;
    const imports = analyzeFlightPackageImports({ manifest: packageManifest, upstreamDirectory }, workspaceSource);
    const exportLanes = (exportDescriptors.get(descriptor.name) ?? []).map((entry): PackageExportLane => {
      const sourcePath = resolvePackageExportSource(entry, upstreamDirectory);
      const resolved = resolveExports(sourcePath, context);
      const source = project.program.getSourceFile(sourcePath);
      if (!source) {
        const subject = portablePath(sourcePath);
        throw createCompilerInventoryFailure(
          'unresolved-source',
          subject,
          `Cannot resolve upstream TypeScript source: ${subject}`,
        );
      }
      const runtimeExports = analyzeTypeScriptSourceRuntimeExports(source, project.checker, project.options);
      const exports = [...resolved.exports.values()].map((record) =>
        applyRuntimeExportDecision(record, runtimeExports.get(record.name), context, entry.specifier, runtimeExports),
      );
      const deduplicated = deduplicateExports(exports);
      const conflicts = mergeExportConflicts(resolved.conflicts, deduplicated.conflicts);
      return {
        conditions: entry.conditions,
        entry: entry.entry,
        exportConflicts: conflicts,
        exports: deduplicated.uniqueExports.sort(compareExports),
        source: entry.source,
        specifier: entry.specifier,
      };
    });
    return {
      bins: packageManifest.bins,
      dependencies: packageManifest.dependencies,
      directory: relativeSource(descriptor.directory, upstreamDirectory),
      exclusion: null,
      exportLanes,
      hostFacts: analyzeFlightPackageHostFacts(packageManifest, imports),
      imports,
      name: descriptor.name,
      sdkExposures: [],
      sdkIncluded: false,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      version: descriptor.version,
    };
  });

  const sortedPackageInventories = [...packageInventories].sort((left, right) =>
    compareTextCodeUnits(left.name, right.name),
  );
  const inventoryByName = new Map(sortedPackageInventories.map((item) => [item.name, item]));
  const sdkExposures = readSdkExposures(
    context.packageByName.get(sdkPackageName),
    inventoryByName,
    context,
    exportDescriptors,
    packageScope,
  );
  const exposedPackageInventories = sortedPackageInventories.map((item): PackageInventory => {
    const packageSdkExposures = sdkExposures.get(item.name) ?? [];
    return {
      ...item,
      sdkExposures: packageSdkExposures,
      sdkIncluded: packageSdkExposures.length > 0,
    };
  });
  const exclusions = analyzeFlightPackageExclusions({
    ...(options.expectedExclusionPackageNames ? { expectedPackageNames: options.expectedExclusionPackageNames } : {}),
    packages: exposedPackageInventories,
  });
  const completedPackageInventories = exposedPackageInventories.map(
    (item): PackageInventory => ({ ...item, exclusion: exclusions.get(item.name) ?? null }),
  );

  return {
    packages: completedPackageInventories,
    schema: 'flight-compiler-inventory/2',
    summary: {
      exportConflicts: sum(completedPackageInventories, (item) =>
        sum(item.exportLanes, (lane) => lane.exportConflicts.length),
      ),
      exportLanes: sum(completedPackageInventories, (item) => item.exportLanes.length),
      excludedPackages: exclusions.size,
      exports: sum(completedPackageInventories, (item) => sum(item.exportLanes, (lane) => lane.exports.length)),
      hostDependencies: sum(completedPackageInventories, (item) => item.hostFacts.dependencies.length),
      hostImports: sum(completedPackageInventories, (item) => item.hostFacts.imports.length),
      packages: completedPackageInventories.length,
      productionImports: sum(completedPackageInventories, (item) => item.imports.length),
      rootExports: sum(completedPackageInventories, (item) => getPackageInventoryRootExportLane(item).exports.length),
      sourceFiles: sum(completedPackageInventories, (item) => item.sourceFiles),
      testFiles: sum(completedPackageInventories, (item) => item.testFiles),
    },
    upstreamCommit: readGitCommit(upstreamDirectory),
  };
}

function applyRuntimeExportDecision(
  record: ExportRecord,
  decision: RuntimeExportDecision | undefined,
  context: AnalysisContext,
  specifier: string,
  decisions: ReadonlyMap<string, RuntimeExportDecision>,
): ExportRecord {
  if (!decision) {
    throw createCompilerInventoryFailure(
      'runtime-export-classification',
      `${specifier}#${record.name}`,
      `Cannot classify runtime export ${record.name} from ${record.source} in ${specifier}; TypeScript reported: ${[
        ...decisions.keys(),
      ].join(', ')}`,
    );
  }
  if (!decision.runtime || !decision.declaration) return { ...record, runtime: false, runtimeBinding: undefined };
  const binding = runtimeBindingRecord(record.name, decision.declaration, context);
  if (binding.fingerprint === record.fingerprint && binding.kind === record.kind && binding.source === record.source) {
    return { ...record, runtime: true, runtimeBinding: undefined };
  }
  return { ...record, runtime: true, runtimeBinding: binding };
}

function compareExports(left: Readonly<ExportRecord>, right: Readonly<ExportRecord>): number {
  return compareTextCodeUnits(left.name, right.name) || compareTextCodeUnits(left.source, right.source);
}

function declarationKind(node: ts.Node): ExportKind | undefined {
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isModuleDeclaration(node) || ts.isSourceFile(node)) return 'namespace';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isVariableDeclaration(node) || ts.isVariableStatement(node)) return 'variable';
  if (ts.isExportAssignment(node)) return 'default';
  return undefined;
}

function deduplicateExports(exports: readonly ExportRecord[]): {
  conflicts: ExportConflict[];
  uniqueExports: ExportRecord[];
} {
  const byName = new Map<string, ExportRecord>();
  const conflictSources = new Map<string, Set<string>>();
  for (const record of exports) {
    const existing = byName.get(record.name);
    if (!existing) {
      byName.set(record.name, record);
      continue;
    }
    if (existing.source === record.source && existing.fingerprint === record.fingerprint) continue;
    const sources = conflictSources.get(record.name) ?? new Set([existing.source]);
    sources.add(record.source);
    conflictSources.set(record.name, sources);
  }
  return {
    conflicts: [...conflictSources]
      .map(([name, sources]) => ({ name, sources: [...sources].sort() }))
      .sort((left, right) => compareTextCodeUnits(left.name, right.name)),
    uniqueExports: [...byName.values()],
  };
}

function mergeExportConflicts(
  resolved: ReadonlyMap<string, ReadonlySet<string>>,
  additional: readonly ExportConflict[],
): ExportConflict[] {
  const conflicts = new Map([...resolved].map(([name, sources]) => [name, new Set(sources)]));
  for (const conflict of additional) {
    const sources = conflicts.get(conflict.name) ?? new Set<string>();
    conflict.sources.forEach((source) => sources.add(source));
    conflicts.set(conflict.name, sources);
  }
  return [...conflicts]
    .map(([name, sources]) => ({ name, sources: [...sources].sort() }))
    .sort((left, right) => compareTextCodeUnits(left.name, right.name));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function exportedBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : exportedBindingNames(element.name),
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isSourceFile(file: string): boolean {
  return /\.tsx?$/u.test(file) && !isTestFile(file) && !file.endsWith('.d.ts');
}

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.tsx?$/u.test(file);
}

function makeRecord(
  name: string,
  kind: ExportKind,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  context: AnalysisContext,
): ExportRecord {
  return {
    fingerprint: fingerprintTypeScriptNode(node, sourceFile),
    kind,
    name,
    runtime: false,
    source: relativeSource(sourceFile.fileName, context.upstreamDirectory),
  };
}

function parseSource(file: string, context: AnalysisContext): ParsedSource {
  const normalizedFile = path.normalize(file);
  const cached = context.parsedSources.get(normalizedFile);
  if (cached) return cached;
  const sourceFile =
    context.program.getSourceFile(normalizedFile) ??
    ts.createSourceFile(
      normalizedFile,
      context.workspaceSource.readTextFile(normalizedFile).replace(/^\uFEFF/u, ''),
      ts.ScriptTarget.Latest,
      true,
      /\.tsx$/iu.test(normalizedFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  const directExports = new Map<string, ExportRecord>();
  const exportDeclarations: ts.ExportDeclaration[] = [];
  const localDeclarations = new Map<string, ExportRecord>();
  const localImports = new Map<string, { importedName: string; specifier: string }>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        localImports.set(statement.importClause.name.text, { importedName: 'default', specifier });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          localImports.set(element.name.text, {
            importedName: element.propertyName?.text ?? element.name.text,
            specifier,
          });
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        localImports.set(bindings.name.text, { importedName: '*', specifier });
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      exportDeclarations.push(statement);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      directExports.set('default', makeRecord('default', 'default', statement, sourceFile, context));
      continue;
    }
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of exportedBindingNames(declaration.name)) {
          const record = makeRecord(name, 'variable', declaration, sourceFile, context);
          localDeclarations.set(name, record);
          if (exported) directExports.set(name, record);
        }
      }
      continue;
    }
    const kind = declarationKind(statement);
    const named =
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
        ? statement.name.text
        : undefined;
    if (!kind || !named) continue;
    const record = makeRecord(named, kind, statement, sourceFile, context);
    setDeclarationRecord(localDeclarations, named, record);
    if (exported) {
      const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : named;
      setDeclarationRecord(directExports, name, name === named ? record : { ...record, name });
    }
  }

  const parsed = { directExports, exportDeclarations, localDeclarations, localImports };
  context.parsedSources.set(normalizedFile, parsed);
  return parsed;
}

function portablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function readSdkExposures(
  sdk: PackageDescriptor | undefined,
  inventoryByName: ReadonlyMap<string, PackageInventory>,
  context: AnalysisContext,
  exportDescriptors: ReadonlyMap<string, PackageExportDescriptor[]>,
  packageScope: string,
): Map<string, SdkExposure[]> {
  if (!sdk) {
    throw createCompilerInventoryFailure(
      'missing-sdk-package',
      packageScope,
      'Expected SDK package while deriving SDK exposure',
    );
  }
  const exposures = new Map<string, SdkExposure[]>();
  for (const sdkLane of exportDescriptors.get(sdk.name) ?? []) {
    const parsed = parseSource(resolvePackageExportSource(sdkLane, context.upstreamDirectory), context);
    for (const declaration of parsed.exportDeclarations) {
      if (!declaration.moduleSpecifier || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
      const target = declaration.moduleSpecifier.text;
      if (!target.startsWith(`${packageScope}/`)) {
        throw createCompilerInventoryFailure(
          'unsupported-package-specifier',
          target,
          `SDK export lane ${sdkLane.specifier} has unsupported external target: ${target}`,
        );
      }
      resolvePackageExportLane(inventoryByName, target, packageScope);
      const targetPackage = new RegExp(`^(${escapeRegularExpression(packageScope)}/[^/]+)`, 'u').exec(target)?.[1];
      if (!targetPackage) {
        throw createCompilerInventoryFailure(
          'unsupported-package-specifier',
          target,
          `Cannot identify SDK target package: ${target}`,
        );
      }
      const packageExposures = exposures.get(targetPackage) ?? [];
      packageExposures.push({ sdkLane: sdkLane.specifier, target });
      exposures.set(targetPackage, packageExposures);
    }
  }
  for (const [packageName, packageExposures] of exposures) {
    const unique = new Map(packageExposures.map((exposure) => [`${exposure.sdkLane}\0${exposure.target}`, exposure]));
    exposures.set(
      packageName,
      [...unique.values()].sort(
        (left, right) =>
          compareTextCodeUnits(left.sdkLane, right.sdkLane) || compareTextCodeUnits(left.target, right.target),
      ),
    );
  }
  return exposures;
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

function resolvePackageExportSource(descriptor: Readonly<PackageExportDescriptor>, upstreamDirectory: string): string {
  return path.resolve(upstreamDirectory, descriptor.source);
}

function resolveExports(file: string, context: AnalysisContext): ResolvedExportSet {
  const root = path.normalize(file);
  const cached = context.resolvedExports.get(root);
  if (cached) return cached;
  const graph = collectExportGraph(root, context);
  const states = new Map<string, ExportCandidates>();
  for (const current of graph) {
    states.set(
      current,
      context.resolvedCandidates.get(current) ?? directExportCandidates(parseSource(current, context).directExports),
    );
  }

  const maximumPasses = Math.max(1, graph.size + 1);
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;
    const next = new Map<string, ExportCandidates>();
    for (const current of [...graph].sort()) {
      const resolved = context.resolvedCandidates.get(current) ?? resolveSourcePass(current, states, context);
      next.set(current, resolved);
      if (!sameExportCandidates(states.get(current)!, resolved)) changed = true;
    }
    states.clear();
    for (const [current, state] of next) states.set(current, state);
    if (!changed) {
      validateNamedExports(graph, states, context);
      for (const [current, state] of states) {
        context.resolvedCandidates.set(current, state);
        context.resolvedExports.set(current, finalizeExportCandidates(state));
      }
      return context.resolvedExports.get(root)!;
    }
  }
  const subject = relativeSource(root, context.upstreamDirectory);
  throw createCompilerInventoryFailure('unresolved-export', subject, `Export graph did not converge for ${subject}`);
}

function collectExportGraph(root: string, context: AnalysisContext): Set<string> {
  const graph = new Set<string>();
  const visit = (file: string): void => {
    const normalized = path.normalize(file);
    if (graph.has(normalized)) return;
    graph.add(normalized);
    if (context.resolvedCandidates.has(normalized)) return;
    const parsed = parseSource(normalized, context);
    for (const declaration of parsed.exportDeclarations) {
      if (declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)) {
        visit(resolveModule(normalized, declaration.moduleSpecifier.text, context));
      } else if (declaration.exportClause && ts.isNamedExports(declaration.exportClause)) {
        for (const element of declaration.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text;
          const imported = parsed.localImports.get(localName);
          if (imported) visit(resolveModule(normalized, imported.specifier, context));
        }
      }
    }
  };
  visit(root);
  return graph;
}

function resolveSourcePass(
  file: string,
  states: ReadonlyMap<string, ExportCandidates>,
  context: AnalysisContext,
): ExportCandidates {
  const parsed = parseSource(file, context);
  const exports = directExportCandidates(parsed.directExports);
  const starCandidates: ExportCandidates = new Map();

  for (const declaration of parsed.exportDeclarations) {
    const targetFile =
      declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
        ? resolveModule(file, declaration.moduleSpecifier.text, context)
        : undefined;
    const target = targetFile ? states.get(targetFile)! : undefined;
    const targetExports = target ?? directExportCandidates(parsed.localDeclarations);
    if (!declaration.exportClause) {
      for (const [name, candidates] of targetExports) {
        if (name === 'default') continue;
        mergeCandidates(starCandidates, name, candidates);
      }
      continue;
    }
    if (ts.isNamespaceExport(declaration.exportClause)) {
      const name = declaration.exportClause.name.text;
      setCandidate(exports, name, makeRecord(name, 'namespace', declaration, declaration.getSourceFile(), context));
      continue;
    }
    for (const element of declaration.exportClause.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const exportedName = element.name.text;
      let candidates = targetExports.get(importedName);
      if (!targetFile && !candidates) {
        const imported = parsed.localImports.get(importedName);
        if (imported && imported.importedName !== '*') {
          const importedFile = resolveModule(file, imported.specifier, context);
          candidates = states.get(importedFile)?.get(imported.importedName);
        }
      }
      if (candidates) {
        exports.set(
          exportedName,
          new Map([...candidates].map(([identity, record]) => [identity, { ...record, name: exportedName }])),
        );
      }
    }
  }

  for (const [name, candidates] of starCandidates) {
    if (exports.has(name)) continue;
    exports.set(name, candidates);
  }
  return exports;
}

function directExportCandidates(exports: ReadonlyMap<string, ExportRecord>): ExportCandidates {
  const candidates: ExportCandidates = new Map();
  for (const [name, record] of exports) setCandidate(candidates, name, record);
  return candidates;
}

function exportIdentity(record: Readonly<ExportRecord>): string {
  return `${record.source}\0${record.fingerprint}`;
}

function finalizeExportCandidates(candidates: Readonly<ExportCandidates>): ResolvedExportSet {
  const conflicts = new Map<string, Set<string>>();
  const exports = new Map<string, ExportRecord>();
  for (const [name, records] of candidates) {
    if (records.size === 1) exports.set(name, records.values().next().value!);
    else conflicts.set(name, new Set([...records.values()].map((record) => record.source)));
  }
  return { conflicts, exports };
}

function mergeCandidates(target: ExportCandidates, name: string, candidates: ReadonlyMap<string, ExportRecord>): void {
  const current = target.get(name) ?? new Map<string, ExportRecord>();
  for (const [identity, record] of candidates) current.set(identity, record);
  target.set(name, current);
}

function sameExportCandidates(left: Readonly<ExportCandidates>, right: Readonly<ExportCandidates>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, leftCandidates] of left) {
    const rightCandidates = right.get(name);
    if (!rightCandidates || leftCandidates.size !== rightCandidates.size) return false;
    for (const identity of leftCandidates.keys()) if (!rightCandidates.has(identity)) return false;
  }
  return true;
}

function setCandidate(target: ExportCandidates, name: string, record: ExportRecord): void {
  target.set(name, new Map([[exportIdentity(record), record]]));
}

function validateNamedExports(
  graph: ReadonlySet<string>,
  states: ReadonlyMap<string, ExportCandidates>,
  context: AnalysisContext,
): void {
  for (const file of graph) {
    const parsed = parseSource(file, context);
    for (const declaration of parsed.exportDeclarations) {
      if (!declaration.exportClause || ts.isNamespaceExport(declaration.exportClause)) continue;
      const targetFile =
        declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
          ? resolveModule(file, declaration.moduleSpecifier.text, context)
          : undefined;
      for (const element of declaration.exportClause.elements) {
        const exportedName = element.name.text;
        assertSingleExportCandidate(states.get(file)?.get(exportedName), exportedName, file, context);
        if (targetFile) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const targetCandidates = states.get(targetFile) ?? context.resolvedCandidates.get(targetFile);
          assertSingleExportCandidate(targetCandidates?.get(importedName), exportedName, file, context);
        }
      }
    }
  }
}

function assertSingleExportCandidate(
  candidates: ReadonlyMap<string, ExportRecord> | undefined,
  exportedName: string,
  file: string,
  context: AnalysisContext,
): void {
  if (candidates?.size === 1) return;
  const source = relativeSource(file, context.upstreamDirectory);
  if (!candidates || candidates.size === 0) {
    throw createCompilerInventoryFailure(
      'unresolved-export',
      `${source}#${exportedName}`,
      `Unresolved public export ${exportedName} in ${source}`,
    );
  }
  const candidatesList = [...new Set([...candidates.values()].map((record) => record.source))].sort().join(', ');
  throw createCompilerInventoryFailure(
    'ambiguous-export',
    `${source}#${exportedName}`,
    `Ambiguous public export ${exportedName} in ${source}: ${candidatesList}`,
  );
}

function resolveModule(containingFile: string, specifier: string, context: AnalysisContext): string {
  const withoutJs = specifier.replace(/\.[cm]?js$/u, '');
  let candidate: string;
  if (withoutJs.startsWith('.')) {
    candidate = path.resolve(path.dirname(containingFile), withoutJs);
  } else {
    const match = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/u.exec(specifier);
    if (!match?.[1]) {
      throw createCompilerInventoryFailure(
        'unsupported-package-specifier',
        specifier,
        `Unsupported export module '${specifier}' in ${portablePath(containingFile)}`,
      );
    }
    const descriptor = context.packageByName.get(match[1]);
    if (!descriptor) {
      throw createCompilerInventoryFailure(
        'unknown-package',
        match[1],
        `Unknown Flight package '${match[1]}' in ${portablePath(containingFile)}`,
      );
    }
    const exportDescriptor = context.exportDescriptors
      .get(descriptor.name)
      ?.find((entry) => entry.specifier === specifier);
    if (!exportDescriptor) {
      throw createCompilerInventoryFailure(
        'missing-package-export',
        specifier,
        `Package import uses an unaccounted export lane: ${specifier}`,
      );
    }
    return resolvePackageExportSource(exportDescriptor, context.upstreamDirectory);
  }
  for (const resolved of [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, 'index.ts')]) {
    if (context.workspaceSource.isFile(resolved)) return resolved;
  }
  throw createCompilerInventoryFailure(
    'unresolved-source',
    `${portablePath(containingFile)}#${specifier}`,
    `Cannot resolve export '${specifier}' from ${portablePath(containingFile)}`,
  );
}

function runtimeBindingRecord(
  name: string,
  declaration: ts.Declaration | ts.SourceFile,
  context: AnalysisContext,
): RuntimeBindingRecord {
  if (ts.isSourceFile(declaration)) {
    const record = makeRecord(name, 'namespace', declaration, declaration, context);
    return { fingerprint: record.fingerprint, kind: record.kind, source: record.source };
  }
  const node: ts.Node = declaration;
  const kind = declarationKind(node);
  if (!kind) {
    throw createCompilerInventoryFailure(
      'runtime-export-classification',
      name,
      `Unsupported runtime binding for ${name} in ${portablePath(declaration.getSourceFile().fileName)}`,
    );
  }
  const record = makeRecord(name, kind, node, declaration.getSourceFile(), context);
  return { fingerprint: record.fingerprint, kind: record.kind, source: record.source };
}

function setDeclarationRecord(target: Map<string, ExportRecord>, name: string, record: ExportRecord): void {
  const existing = target.get(name);
  if (
    record.kind === 'namespace' &&
    (existing?.kind === 'class' || existing?.kind === 'enum' || existing?.kind === 'function')
  ) {
    return;
  }
  target.set(name, record);
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function walkFiles(directory: string, predicate: (file: string) => boolean, workspace: WorkspaceSource): string[] {
  if (!workspace.isDirectory(directory)) return [];
  const files: string[] = [];
  for (const entry of workspace.listDirectory(directory)) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory) files.push(...walkFiles(target, predicate, workspace));
    else if (predicate(target)) files.push(target);
  }
  return files.sort();
}

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import type {
  AnalyzeFlightWorkspaceOptions,
  ExportConflict,
  ExportKind,
  ExportRecord,
  PackageExportCondition,
  PackageExportLane,
  PackageInventory,
  RuntimeBindingRecord,
  SdkExposure,
  UpstreamInventory,
} from '../model/inventory.ts';
import { fingerprintTypeScriptNode } from './fingerprint.ts';
import { createTypeScriptProject } from './program.ts';
import { runtimeExportsForSource } from './runtimeValues.ts';
import type { RuntimeExportDecision } from './runtimeValues.ts';

interface PackageDescriptor {
  directory: string;
  name: string;
  version: string;
}

export interface PackageExportDescriptor {
  conditions: PackageExportCondition[];
  entry: string;
  source: string;
  specifier: string;
}

interface ParsedSource {
  directExports: Map<string, ExportRecord>;
  exportDeclarations: ts.ExportDeclaration[];
  localDeclarations: Map<string, ExportRecord>;
  localImports: Map<string, { importedName: string; specifier: string }>;
}

interface AnalysisContext {
  packageByName: ReadonlyMap<string, PackageDescriptor>;
  parsedSources: Map<string, ParsedSource>;
  resolvedExports: Map<string, Map<string, ExportRecord>>;
  upstreamDirectory: string;
}

export function analyzeFlightWorkspace(options: Readonly<AnalyzeFlightWorkspaceOptions>): UpstreamInventory {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const packagesDirectory = path.resolve(upstreamDirectory, options.packagesDirectory ?? 'packages');
  const packageScope = options.packageScope ?? '@flighthq';
  const sdkPackageName = options.sdkPackageName ?? `${packageScope}/sdk`;
  const packages = discoverPackages(packagesDirectory, packageScope);
  const project = createTypeScriptProject(path.resolve(upstreamDirectory, options.tsconfigPath ?? 'tsconfig.json'));
  const context: AnalysisContext = {
    packageByName: new Map(packages.map((item) => [item.name, item])),
    parsedSources: new Map(),
    resolvedExports: new Map(),
    upstreamDirectory,
  };
  const exportDescriptors = new Map(
    packages.map((descriptor) => [descriptor.name, readPackageExportDescriptors(descriptor, upstreamDirectory)]),
  );

  const packageInventories = packages.map((descriptor): PackageInventory => {
    const sourceDirectory = path.join(descriptor.directory, 'src');
    const sourceFiles = walkFiles(sourceDirectory, isSourceFile);
    const testFiles = walkFiles(sourceDirectory, isTestFile);
    const packageJson = readJson(path.join(descriptor.directory, 'package.json'));
    const exportLanes = (exportDescriptors.get(descriptor.name) ?? []).map((entry): PackageExportLane => {
      const resolved = [...resolveExports(entry.source, context, new Set()).values()];
      const source = project.program.getSourceFile(entry.source);
      if (!source) throw new Error(`Cannot resolve upstream TypeScript source: ${portablePath(entry.source)}`);
      const runtimeExports = runtimeExportsForSource(source, project.checker, project.options);
      const exports = resolved.map((record) =>
        applyRuntimeExportDecision(record, runtimeExports.get(record.name), context, entry.specifier, runtimeExports),
      );
      const { conflicts, uniqueExports } = deduplicateExports(exports);
      return {
        conditions: entry.conditions,
        entry: entry.entry,
        exportConflicts: conflicts,
        exports: uniqueExports.sort(compareExports),
        source: relativeSource(entry.source, upstreamDirectory),
        specifier: entry.specifier,
      };
    });
    return {
      dependencies: collectDependencies(packageJson),
      directory: relativeSource(descriptor.directory, upstreamDirectory),
      exportLanes,
      name: descriptor.name,
      sdkExposures: [],
      sdkIncluded: false,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      version: descriptor.version,
    };
  });

  packageInventories.sort((left, right) => left.name.localeCompare(right.name));
  const inventoryByName = new Map(packageInventories.map((item) => [item.name, item]));
  const sdkExposures = readSdkExposures(
    context.packageByName.get(sdkPackageName),
    inventoryByName,
    context,
    exportDescriptors,
    packageScope,
  );
  for (const item of packageInventories) {
    item.sdkExposures = sdkExposures.get(item.name) ?? [];
    item.sdkIncluded = item.sdkExposures.length > 0;
  }

  return {
    packages: packageInventories,
    schema: 'flight-compiler-inventory/1',
    summary: {
      exportConflicts: sum(packageInventories, (item) => sum(item.exportLanes, (lane) => lane.exportConflicts.length)),
      exportLanes: sum(packageInventories, (item) => item.exportLanes.length),
      exports: sum(packageInventories, (item) => sum(item.exportLanes, (lane) => lane.exports.length)),
      packages: packageInventories.length,
      rootExports: sum(packageInventories, (item) => packageRootExportLane(item).exports.length),
      sourceFiles: sum(packageInventories, (item) => item.sourceFiles),
      testFiles: sum(packageInventories, (item) => item.testFiles),
    },
    upstreamCommit: readGitCommit(upstreamDirectory),
  };
}

export function packageRootExportLane(inventory: Readonly<PackageInventory>): PackageExportLane {
  const lane = inventory.exportLanes.find((candidate) => candidate.entry === '.');
  if (!lane) throw new Error(`Package manifest has no root export lane: ${inventory.name}`);
  return lane;
}

export function readGitCommit(directory: string): string {
  try {
    const commit = execFileSync('git', ['-C', path.resolve(directory), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`Git returned an invalid commit: ${commit}`);
    return commit;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Upstream directory is not an initialized Git checkout${detail}`);
  }
}

export function readPackageExportManifest(
  packageDirectory: string,
  upstreamDirectory = path.dirname(path.resolve(packageDirectory)),
): PackageExportDescriptor[] {
  const directory = path.resolve(packageDirectory);
  const packageJson = readJson(path.join(directory, 'package.json'));
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`Invalid package metadata: ${portablePath(directory)}`);
  }
  return readPackageExportDescriptors(
    { directory, name: packageJson.name, version: packageJson.version },
    path.resolve(upstreamDirectory),
  );
}

export function resolvePackageExportLane(
  inventoryByName: ReadonlyMap<string, PackageInventory>,
  specifier: string,
  packageScope = '@flighthq',
): PackageExportLane {
  const escapedScope = escapeRegularExpression(packageScope);
  const match = new RegExp(`^(${escapedScope}/[^/]+)(?<subpath>/.*)?$`, 'u').exec(specifier);
  const packageName = match?.[1];
  if (!packageName) throw new Error(`Unsupported Flight package specifier: ${specifier}`);
  const inventory = inventoryByName.get(packageName);
  if (!inventory) throw new Error(`Unknown Flight package in public import: ${packageName}`);
  const entry = match.groups?.subpath ? `.${match.groups.subpath}` : '.';
  const lane = inventory.exportLanes.find((candidate) => candidate.entry === entry);
  if (!lane) throw new Error(`Package import uses an unaccounted export lane: ${specifier}`);
  return lane;
}

function applyRuntimeExportDecision(
  record: ExportRecord,
  decision: RuntimeExportDecision | undefined,
  context: AnalysisContext,
  specifier: string,
  decisions: ReadonlyMap<string, RuntimeExportDecision>,
): ExportRecord {
  if (!decision) {
    throw new Error(
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

function collectDependencies(packageJson: Readonly<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = packageJson[key];
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) names.add(name);
    }
  }
  return [...names].sort();
}

function compareExports(left: Readonly<ExportRecord>, right: Readonly<ExportRecord>): number {
  return left.name.localeCompare(right.name) || left.source.localeCompare(right.source);
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
      .sort((left, right) => left.name.localeCompare(right.name)),
    uniqueExports: [...byName.values()],
  };
}

function discoverPackages(packagesDirectory: string, packageScope: string): PackageDescriptor[] {
  if (!existsSync(packagesDirectory)) throw new Error(`Flight packages directory does not exist: ${packagesDirectory}`);
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDirectory, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'package.json')))
    .map((directory) => {
      const packageJson = readJson(path.join(directory, 'package.json'));
      if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
        throw new Error(`Invalid package metadata: ${portablePath(directory)}`);
      }
      if (!packageJson.name.startsWith(`${packageScope}/`)) {
        throw new Error(`Package ${packageJson.name} is outside configured scope ${packageScope}`);
      }
      return { directory, name: packageJson.name, version: packageJson.version };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
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
  const text = readFileSync(normalizedFile, 'utf8').replace(/^\uFEFF/u, '');
  const sourceFile = ts.createSourceFile(normalizedFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
          const record = makeRecord(name, 'variable', statement, sourceFile, context);
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

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function readPackageExportDescriptors(
  descriptor: Readonly<PackageDescriptor>,
  upstreamDirectory: string,
): PackageExportDescriptor[] {
  const packageJson = readJson(path.join(descriptor.directory, 'package.json'));
  const manifestExports = packageJson.exports;
  if (!manifestExports || typeof manifestExports !== 'object' || Array.isArray(manifestExports)) {
    throw new Error(`Package manifest has no export map: ${descriptor.name}`);
  }
  const descriptors = Object.entries(manifestExports).map(([entry, rawConditions]): PackageExportDescriptor => {
    if (entry !== '.' && !/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry)) {
      throw new Error(`Unsupported package export lane '${entry}' in ${descriptor.name}`);
    }
    if (!rawConditions || typeof rawConditions !== 'object' || Array.isArray(rawConditions)) {
      throw new Error(`Package export lane ${descriptor.name}${entry.slice(1)} has no condition map`);
    }
    const conditionsRecord = rawConditions as Record<string, unknown>;
    const typesTarget = conditionsRecord.types;
    const defaultTarget = conditionsRecord.default;
    if (typeof typesTarget !== 'string' || typeof defaultTarget !== 'string') {
      throw new Error(`Package export lane ${descriptor.name}${entry.slice(1)} needs types and default targets`);
    }
    const conditions = Object.entries(conditionsRecord)
      .map(([condition, target]): PackageExportCondition => {
        if (typeof target !== 'string') {
          throw new Error(
            `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] is not a string target`,
          );
        }
        return {
          condition,
          source: relativeSource(sourceForExportTarget(descriptor, entry, condition, target), upstreamDirectory),
          target,
        };
      })
      .sort((left, right) => left.condition.localeCompare(right.condition));
    return {
      conditions,
      entry,
      source: sourceForExportTarget(descriptor, entry, 'types', typesTarget),
      specifier: entry === '.' ? descriptor.name : `${descriptor.name}${entry.slice(1)}`,
    };
  });
  if (!descriptors.some((entry) => entry.entry === '.')) {
    throw new Error(`Package manifest has no root export lane: ${descriptor.name}`);
  }
  return descriptors.sort((left, right) => left.entry.localeCompare(right.entry));
}

function readSdkExposures(
  sdk: PackageDescriptor | undefined,
  inventoryByName: ReadonlyMap<string, PackageInventory>,
  context: AnalysisContext,
  exportDescriptors: ReadonlyMap<string, PackageExportDescriptor[]>,
  packageScope: string,
): Map<string, SdkExposure[]> {
  if (!sdk) throw new Error('Expected SDK package while deriving SDK exposure');
  const exposures = new Map<string, SdkExposure[]>();
  for (const sdkLane of exportDescriptors.get(sdk.name) ?? []) {
    const parsed = parseSource(sdkLane.source, context);
    for (const declaration of parsed.exportDeclarations) {
      if (!declaration.moduleSpecifier || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
      const target = declaration.moduleSpecifier.text;
      if (!target.startsWith(`${packageScope}/`)) {
        throw new Error(`SDK export lane ${sdkLane.specifier} has unsupported external target: ${target}`);
      }
      resolvePackageExportLane(inventoryByName, target, packageScope);
      const targetPackage = new RegExp(`^(${escapeRegularExpression(packageScope)}/[^/]+)`, 'u').exec(target)?.[1];
      if (!targetPackage) throw new Error(`Cannot identify SDK target package: ${target}`);
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
        (left, right) => left.sdkLane.localeCompare(right.sdkLane) || left.target.localeCompare(right.target),
      ),
    );
  }
  return exposures;
}

function relativeSource(file: string, upstreamDirectory: string): string {
  const relative = path.relative(upstreamDirectory, path.resolve(file));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Source is outside upstream checkout: ${portablePath(file)}`);
  }
  return portablePath(relative);
}

function resolveExports(file: string, context: AnalysisContext, resolving: Set<string>): Map<string, ExportRecord> {
  const normalizedFile = path.normalize(file);
  const cached = context.resolvedExports.get(normalizedFile);
  if (cached) return cached;
  if (resolving.has(normalizedFile)) return new Map();
  resolving.add(normalizedFile);
  const parsed = parseSource(normalizedFile, context);
  const exports = new Map(parsed.directExports);

  for (const declaration of parsed.exportDeclarations) {
    const targetFile =
      declaration.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
        ? resolveModule(normalizedFile, declaration.moduleSpecifier.text, context.packageByName)
        : undefined;
    const targetExports = targetFile ? resolveExports(targetFile, context, resolving) : parsed.localDeclarations;
    if (!declaration.exportClause) {
      for (const [name, record] of targetExports) {
        if (name !== 'default' && !exports.has(name)) exports.set(name, record);
      }
      continue;
    }
    if (ts.isNamespaceExport(declaration.exportClause)) {
      const name = declaration.exportClause.name.text;
      exports.set(name, makeRecord(name, 'namespace', declaration, declaration.getSourceFile(), context));
      continue;
    }
    for (const element of declaration.exportClause.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const exportedName = element.name.text;
      let record = targetExports.get(importedName);
      if (!targetFile && !record) {
        const imported = parsed.localImports.get(importedName);
        if (imported) {
          const importedFile = resolveModule(normalizedFile, imported.specifier, context.packageByName);
          const importedExports = resolveExports(importedFile, context, resolving);
          record = imported.importedName === '*' ? undefined : importedExports.get(imported.importedName);
        }
      }
      if (!record) {
        throw new Error(
          `Unresolved public export ${exportedName} in ${relativeSource(normalizedFile, context.upstreamDirectory)}`,
        );
      }
      exports.set(exportedName, { ...record, name: exportedName });
    }
  }

  resolving.delete(normalizedFile);
  context.resolvedExports.set(normalizedFile, exports);
  return exports;
}

function resolveModule(
  containingFile: string,
  specifier: string,
  packageByName: ReadonlyMap<string, PackageDescriptor>,
): string {
  const withoutJs = specifier.replace(/\.[cm]?js$/u, '');
  let candidate: string;
  if (withoutJs.startsWith('.')) {
    candidate = path.resolve(path.dirname(containingFile), withoutJs);
  } else {
    const match = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/u.exec(withoutJs);
    if (!match?.[1]) throw new Error(`Unsupported export module '${specifier}' in ${portablePath(containingFile)}`);
    const descriptor = packageByName.get(match[1]);
    if (!descriptor) throw new Error(`Unknown Flight package '${match[1]}' in ${portablePath(containingFile)}`);
    candidate = path.join(descriptor.directory, 'src', match[2] ?? 'index');
  }
  for (const resolved of [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, 'index.ts')]) {
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  throw new Error(`Cannot resolve export '${specifier}' from ${portablePath(containingFile)}`);
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
  let node: ts.Node = declaration;
  if (ts.isVariableDeclaration(declaration) && ts.isVariableStatement(declaration.parent.parent)) {
    node = declaration.parent.parent;
  }
  const kind = declarationKind(node);
  if (!kind)
    throw new Error(`Unsupported runtime binding for ${name} in ${portablePath(declaration.getSourceFile().fileName)}`);
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

function sourceForExportTarget(
  descriptor: Readonly<PackageDescriptor>,
  entry: string,
  condition: string,
  target: string,
): string {
  const match = /^\.\/dist\/(?<stem>.+?)\.(?:d\.[cm]?ts|[cm]?js)$/u.exec(target);
  const stem = match?.groups?.stem;
  if (!stem || stem.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new Error(
      `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] has an unaccounted target: ${target}`,
    );
  }
  const sourceBase = path.join(descriptor.directory, 'src', ...stem.split('/'));
  for (const source of [`${sourceBase}.ts`, `${sourceBase}.tsx`]) {
    if (existsSync(source) && statSync(source).isFile()) return source;
  }
  throw new Error(
    `Package export condition ${descriptor.name}${entry.slice(1)} [${condition}] has no source barrel for ${target}`,
  );
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function walkFiles(directory: string, predicate: (file: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(target, predicate));
    else if (entry.isFile() && predicate(target)) files.push(target);
  }
  return files.sort();
}

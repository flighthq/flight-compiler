import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import {
  createCompilerInvariantFailure,
  normalizeEmittedFile,
  validateCompilerEmittedSourceSyntax,
  validateCompilerTargetCompilationSmoke,
} from '../../compiler-emission/src/index.js';
import {
  collectCompilerModuleLinkRequests,
  createCompilerModuleEvaluationPlan,
} from '../../compiler-module/src/index.js';
import { applySemanticPatchSet } from '../../compiler-patch/src/index.js';
import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type {
  CompileIrModulesOptions,
  CompileIrModulesResult,
  CompileTypeScriptModulesOptions,
  CompilerDiagnostic,
  CompilerDiagnosticCode,
  CompilerDiagnosticsFailure,
  CompilerModuleLinkDependency,
  CompilerModuleResolutionPlan,
  EmittedFile,
  IrModule,
} from '../../compiler-types/src/index.js';

export function compileIrModules<BackendOptions>(
  options: Readonly<CompileIrModulesOptions<BackendOptions>>,
): CompileIrModulesResult {
  validateModuleIdentities(options.modules);
  const patched = applySemanticPatchSet(options.modules, options.patches ?? [], options.backend.name);
  const modules = [...patched.modules].sort(compareModules);
  const emitContext = {
    ...(options.moduleResolution ? { moduleResolution: options.moduleResolution } : {}),
    modules,
    options: options.backendOptions,
  };
  const emissionSession = options.backend.createEmissionSession?.({
    ...emitContext,
    moduleEvaluation: createCompilerModuleEvaluationPlan({
      dependencies: createCompilerModuleEvaluationDependencies(modules, options.moduleResolution),
      entries: modules,
      modules,
    }),
  });
  const files = modules
    .flatMap((module) =>
      emissionSession ? emissionSession.emitModule(module) : options.backend.emitModule(module, emitContext),
    )
    .map(normalizeEmittedFile)
    .sort(compareEmittedFiles);
  validateEmittedFiles(files);
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
  return {
    compilation: { backend: options.backend.name, files },
    diagnostics: [],
    patchAudit: patched.audit,
    report: {
      backend: options.backend.name,
      emittedFiles: files.length,
      modules: modules.length,
      schema: 'flight-compiler-report/1',
    },
  };
}

// Explicit module-resolution edges are authoritative. Lowering also resolves relative imports among
// the compiled sources, which never appear as edges; the evaluation plan still requires a route for
// every linked request, so this completes only the missing relative links. Bare specifiers keep
// needing an explicit edge.
function createCompilerModuleEvaluationDependencies(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: CompilerModuleResolutionPlan | undefined,
): readonly CompilerModuleLinkDependency[] {
  const dependencies: CompilerModuleLinkDependency[] = [];
  const coverage = new Map<string, { names: Set<string>; whole: boolean }>();
  const coverageKey = (importer: Readonly<IrModule>, specifier: string): string =>
    `${importer.packageName}\0${normalizePathPortable(importer.source)}\0${importer.name}\0${specifier}`;
  const record = (importer: Readonly<IrModule>, dependency: Readonly<CompilerModuleLinkDependency>): void => {
    const key = coverageKey(importer, dependency.specifier);
    const existing = coverage.get(key) ?? { names: new Set<string>(), whole: false };
    if (dependency.importedNames === undefined) existing.whole = true;
    else for (const name of dependency.importedNames) existing.names.add(name);
    coverage.set(key, existing);
  };
  for (const edge of moduleResolution?.edges ?? []) {
    const target = modules.find(
      (module) => module.packageName === edge.target.packageName && module.source === edge.target.source,
    );
    if (!target) continue;
    const importers = edge.importer
      ? modules.filter(
          (module) =>
            module.packageName === edge.importer!.packageName &&
            module.source === edge.importer!.source &&
            module.name === edge.importer!.name,
        )
      : modules.filter((module) => module.imports.some((imported) => imported.specifier === edge.specifier));
    for (const importer of importers) {
      const dependency: CompilerModuleLinkDependency = {
        importer: createCompilerModuleLinkIdentity(importer),
        ...(edge.importedNames ? { importedNames: edge.importedNames } : {}),
        specifier: edge.specifier,
        target: createCompilerModuleLinkIdentity(target),
      };
      dependencies.push(dependency);
      record(importer, dependency);
    }
  }
  const resolutionCache = new Map<string, Readonly<IrModule> | undefined>();
  for (const importer of modules) {
    const uncovered = new Map<string, { hasWhole: boolean; names: string[] }>();
    for (const request of collectCompilerModuleLinkRequests(importer)) {
      if (!isCompilerModuleLinkRelativeSpecifier(request.specifier)) continue;
      const existing = coverage.get(coverageKey(importer, request.specifier));
      if (existing?.whole) continue;
      if (request.imported !== undefined && existing?.names.has(request.imported)) continue;
      const group = uncovered.get(request.specifier) ?? { hasWhole: false, names: [] };
      if (request.imported === undefined) group.hasWhole = true;
      else if (!group.names.includes(request.imported)) group.names.push(request.imported);
      uncovered.set(request.specifier, group);
    }
    for (const [specifier, group] of uncovered) {
      const existing = coverage.get(coverageKey(importer, specifier));
      if (existing && !existing.whole) {
        // Extend an explicit named route only with disjoint names. A whole request cannot be covered
        // without overlapping it, so the neutral planner keeps its structured failure for that shape.
        if (group.hasWhole) continue;
        const target = resolveCompilerModuleLinkRelativeTarget(importer, specifier, modules, resolutionCache);
        if (!target) continue;
        for (const name of group.names) {
          const dependency: CompilerModuleLinkDependency = {
            importer: createCompilerModuleLinkIdentity(importer),
            importedNames: [name],
            specifier,
            target: createCompilerModuleLinkIdentity(target),
          };
          dependencies.push(dependency);
          record(importer, dependency);
        }
        continue;
      }
      const target = resolveCompilerModuleLinkRelativeTarget(importer, specifier, modules, resolutionCache);
      if (!target) continue;
      const dependency: CompilerModuleLinkDependency = {
        importer: createCompilerModuleLinkIdentity(importer),
        specifier,
        target: createCompilerModuleLinkIdentity(target),
      };
      dependencies.push(dependency);
      record(importer, dependency);
    }
  }
  return dependencies;
}

function isCompilerModuleLinkRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveCompilerModuleLinkRelativeTarget(
  importer: Readonly<IrModule>,
  specifier: string,
  modules: readonly Readonly<IrModule>[],
  cache: Map<string, Readonly<IrModule> | undefined>,
): Readonly<IrModule> | undefined {
  const key = `${importer.packageName}\0${normalizePathPortable(importer.source)}\0${specifier}`;
  if (cache.has(key)) return cache.get(key);
  // The same portable rule the target backends use for a relative import lowering already resolved:
  // a script extension maps to a TypeScript source, and a directory may resolve through index.
  const base = normalizePathPortable(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.(?:[cm]?js)$/u, '.ts')),
  );
  const candidates = new Set([base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]);
  const matching = modules.filter(
    (module) =>
      module.packageName === importer.packageName &&
      candidates.has(normalizePathPortable(path.posix.normalize(module.source))),
  );
  const target = matching.length === 1 ? matching[0] : undefined;
  cache.set(key, target);
  return target;
}

function createCompilerModuleLinkIdentity(module: Readonly<IrModule>): Readonly<{
  name: string;
  packageName: string;
  source: string;
}> {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

export function compileTypeScriptModules<BackendOptions>(
  options: Readonly<CompileTypeScriptModulesOptions<BackendOptions>>,
): CompileIrModulesResult {
  const profileTypeNameEvidence = options.backend.createTypeScriptProfileTypeNameEvidence?.(options.backendOptions);
  const lowered = lowerTypeScriptSources(options.sources, options.moduleResolution, {
    ...(profileTypeNameEvidence ? { profileTypeNameEvidence } : {}),
  });
  const diagnostics = lowered.flatMap((result) => result.diagnostics);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw createCompilerDiagnosticsFailure(errors);
  return compileIrModules({
    backend: options.backend,
    backendOptions: options.backendOptions,
    ...(options.moduleResolution ? { moduleResolution: options.moduleResolution } : {}),
    modules: lowered.map((result) => result.module),
    ...(options.patches ? { patches: options.patches } : {}),
    ...(options.sourceParser ? { sourceParser: options.sourceParser } : {}),
    ...(options.targetCompilationSmoke ? { targetCompilationSmoke: options.targetCompilationSmoke } : {}),
  });
}

export function createCompilerDiagnosticsFailure(
  diagnostics: readonly CompilerDiagnostic[],
): CompilerDiagnosticsFailure {
  const orderedDiagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic })).sort(compareDiagnostics);
  const message = `TypeScript lowering produced ${String(orderedDiagnostics.length)} diagnostic(s):\n${orderedDiagnostics
    .map((diagnostic) => `${formatCompilerDiagnosticLocation(diagnostic)} [${diagnostic.code}] ${diagnostic.message}`)
    .join('\n')}`;
  const failure = Object.assign(new Error(message), {
    diagnostics: orderedDiagnostics,
    kind: 'compiler-diagnostics' as const,
  });
  failure.name = 'CompilerDiagnosticsError';
  return failure;
}

export function isCompilerDiagnosticsFailure(value: unknown): value is CompilerDiagnosticsFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-diagnostics' &&
    'diagnostics' in value &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isCompilerDiagnosticValue)
  );
}

export function parseTypeScriptSource(fileName: string, source: string): ts.SourceFile {
  const scriptKind = /\.tsx$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function compareDiagnostics(left: Readonly<CompilerDiagnostic>, right: Readonly<CompilerDiagnostic>): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    getCompilerDiagnosticLine(left) - getCompilerDiagnosticLine(right) ||
    getCompilerDiagnosticColumn(left) - getCompilerDiagnosticColumn(right) ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

// An absent position is a diagnostic whose syntax lives in another module. Order those before the
// located ones so the ordering stays total and deterministic.
function getCompilerDiagnosticLine(diagnostic: Readonly<CompilerDiagnostic>): number {
  return diagnostic.line ?? 0;
}

function getCompilerDiagnosticColumn(diagnostic: Readonly<CompilerDiagnostic>): number {
  return diagnostic.column ?? 0;
}

function formatCompilerDiagnosticLocation(diagnostic: Readonly<CompilerDiagnostic>): string {
  const location = `${diagnostic.packageName}/${diagnostic.source}`;
  return diagnostic.line === undefined || diagnostic.column === undefined
    ? location
    : `${location}:${String(diagnostic.line)}:${String(diagnostic.column)}`;
}

function compareEmittedFiles(left: Readonly<EmittedFile>, right: Readonly<EmittedFile>): number {
  return compareTextCodeUnits(left.path, right.path);
}

function isCompilerDiagnosticValue(value: unknown): value is CompilerDiagnostic {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(compilerDiagnosticCodes, value.code) &&
    isOptionalCompilerDiagnosticPosition(value, 'column') &&
    isOptionalCompilerDiagnosticPosition(value, 'line') &&
    'message' in value &&
    typeof value.message === 'string' &&
    'packageName' in value &&
    typeof value.packageName === 'string' &&
    'severity' in value &&
    (value.severity === 'error' || value.severity === 'warning') &&
    'source' in value &&
    typeof value.source === 'string'
  );
}

function isOptionalCompilerDiagnosticPosition(value: object, key: 'column' | 'line'): boolean {
  const position: unknown = Reflect.get(value, key);
  return position === undefined || (typeof position === 'number' && Number.isInteger(position) && position >= 1);
}

function compareModules(left: Readonly<IrModule>, right: Readonly<IrModule>): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.name, right.name)
  );
}

function validateEmittedFiles(files: readonly EmittedFile[]): void {
  const paths = new Map<string, string>();
  for (const file of files) {
    const collisionKey = file.path.toLowerCase();
    const existingPath = paths.get(collisionKey);
    if (existingPath !== undefined) {
      throw createCompilerInvariantFailure(
        'duplicate-emitted-path',
        file.path,
        `Backend emitted colliding file paths: ${existingPath}, ${file.path}`,
      );
    }
    paths.set(collisionKey, file.path);
  }
}

function validateModuleIdentities(modules: readonly IrModule[]): void {
  const identities = new Set<string>();
  for (const module of modules) {
    const identity = `${module.packageName}\0${module.source}\0${module.name}`;
    if (identities.has(identity)) {
      const subject = `${module.packageName}/${module.source}#${module.name}`;
      throw createCompilerInvariantFailure(
        'duplicate-module-identity',
        subject,
        `Duplicate compiler module identity: ${subject}`,
      );
    }
    identities.add(identity);
  }
}

const compilerDiagnosticCodes = {
  'unsupported-typescript': true,
} as const satisfies Readonly<Record<CompilerDiagnosticCode, true>>;

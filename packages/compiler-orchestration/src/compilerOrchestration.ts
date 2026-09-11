import ts from 'typescript';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import {
  createCompilerInvariantFailure,
  normalizeEmittedFile,
  validateCompilerEmittedSourceSyntax,
  validateCompilerTargetCompilationSmoke,
} from '../../compiler-emission/src/index.js';
import { applySemanticPatchSet } from '../../compiler-patch/src/index.js';
import { lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type {
  CompileIrModulesOptions,
  CompileIrModulesResult,
  CompileTypeScriptModulesOptions,
  CompilerDiagnostic,
  CompilerDiagnosticCode,
  CompilerDiagnosticsFailure,
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
  const emissionSession = options.backend.createEmissionSession?.(emitContext);
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

export function compileTypeScriptModules<BackendOptions>(
  options: Readonly<CompileTypeScriptModulesOptions<BackendOptions>>,
): CompileIrModulesResult {
  const lowered = lowerTypeScriptSources(options.sources, options.moduleResolution);
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
    .map(
      (diagnostic) =>
        `${diagnostic.packageName}/${diagnostic.source}:${String(diagnostic.line)}:${String(diagnostic.column)} [${diagnostic.code}] ${diagnostic.message}`,
    )
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
    left.line - right.line ||
    left.column - right.column ||
    compareTextCodeUnits(left.code, right.code) ||
    compareTextCodeUnits(left.message, right.message)
  );
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
    'column' in value &&
    typeof value.column === 'number' &&
    Number.isInteger(value.column) &&
    value.column >= 1 &&
    'line' in value &&
    typeof value.line === 'number' &&
    Number.isInteger(value.line) &&
    value.line >= 1 &&
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

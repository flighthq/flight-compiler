import ts from 'typescript';

import { createCompilerInvariantFailure, normalizeEmittedFile } from '../../compiler-emission/src/index.js';
import { applySemanticPatchSet } from '../../compiler-patch/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
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
  const files = modules
    .flatMap((module) => options.backend.emitModule(module, { modules, options: options.backendOptions }))
    .map(normalizeEmittedFile)
    .sort((left, right) => left.path.localeCompare(right.path));
  validateEmittedFiles(files);
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
  const lowered = options.sources.map(({ sourceFile, ...loweringOptions }) =>
    lowerTypeScriptSource(sourceFile, loweringOptions),
  );
  const diagnostics = lowered.flatMap((result) => result.diagnostics);
  if (diagnostics.length > 0) throw createCompilerDiagnosticsFailure(diagnostics);
  return compileIrModules({
    backend: options.backend,
    backendOptions: options.backendOptions,
    modules: lowered.map((result) => result.module),
    ...(options.patches ? { patches: options.patches } : {}),
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
    left.packageName.localeCompare(right.packageName) ||
    left.source.localeCompare(right.source) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
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
    'source' in value &&
    typeof value.source === 'string'
  );
}

function compareModules(left: Readonly<IrModule>, right: Readonly<IrModule>): number {
  return (
    left.packageName.localeCompare(right.packageName) ||
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name)
  );
}

function validateEmittedFiles(files: readonly EmittedFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) {
      throw createCompilerInvariantFailure(
        'duplicate-emitted-path',
        file.path,
        `Backend emitted duplicate file path: ${file.path}`,
      );
    }
    paths.add(file.path);
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

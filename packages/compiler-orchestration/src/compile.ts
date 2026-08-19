import ts from 'typescript';

import { createCompilerInvariantError, normalizeEmittedFile } from '../../compiler-emission/src/index.js';
import { applySemanticPatches } from '../../compiler-patch/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompileModulesOptions,
  CompileModulesResult,
  CompileTypeScriptModulesOptions,
  CompilerDiagnostic,
  CompilerDiagnosticsFailure,
  EmittedFile,
  IrModule,
} from '../../compiler-types/src/index.js';

export function compileModules<BackendOptions>(
  options: Readonly<CompileModulesOptions<BackendOptions>>,
): CompileModulesResult {
  validateModuleIdentities(options.modules);
  const patched = applySemanticPatches(options.modules, options.patches ?? [], options.backend.name);
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
): CompileModulesResult {
  const lowered = options.sources.map(({ sourceFile, ...loweringOptions }) =>
    lowerTypeScriptSource(sourceFile, loweringOptions),
  );
  const diagnostics = lowered.flatMap((result) => result.diagnostics).sort(compareDiagnostics);
  if (diagnostics.length > 0) throw createCompilerDiagnosticsError(diagnostics);
  return compileModules({
    backend: options.backend,
    backendOptions: options.backendOptions,
    modules: lowered.map((result) => result.module),
    ...(options.patches ? { patches: options.patches } : {}),
  });
}

export function parseTypeScriptSource(fileName: string, source: string): ts.SourceFile {
  const scriptKind = /\.tsx$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

export function createCompilerDiagnosticsError(diagnostics: readonly CompilerDiagnostic[]): CompilerDiagnosticsFailure {
  const message = `TypeScript lowering produced ${String(diagnostics.length)} diagnostic(s):\n${diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.source}:${String(diagnostic.line)}:${String(diagnostic.column)} [${diagnostic.code}] ${diagnostic.message}`,
    )
    .join('\n')}`;
  const failure = Object.assign(new Error(message), {
    diagnostics,
    kind: 'compiler-diagnostics' as const,
  });
  failure.name = 'CompilerDiagnosticsError';
  return failure;
}

export function isCompilerDiagnosticsError(value: unknown): value is CompilerDiagnosticsFailure {
  return value instanceof Error && 'kind' in value && value.kind === 'compiler-diagnostics';
}

function compareDiagnostics(left: Readonly<CompilerDiagnostic>, right: Readonly<CompilerDiagnostic>): number {
  return (
    left.source.localeCompare(right.source) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
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
      throw createCompilerInvariantError(
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
      throw createCompilerInvariantError(
        'duplicate-module-identity',
        subject,
        `Duplicate compiler module identity: ${subject}`,
      );
    }
    identities.add(identity);
  }
}

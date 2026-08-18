import ts from 'typescript';

import { normalizeEmittedFile } from '../backend/emission.ts';
import { lowerTypeScriptSource } from '../analyze/typescript.ts';
import type { LowerTypeScriptSourceOptions } from '../analyze/typescript.ts';
import type { EmittedFile } from '../model/backend.ts';
import type { CompileModulesOptions, CompileModulesResult } from '../model/compiler.ts';
import type { CompilerDiagnostic, IrModule } from '../model/ir.ts';
import { applySemanticPatches } from '../patch/apply.ts';

export interface TypeScriptModuleInput extends LowerTypeScriptSourceOptions {
  sourceFile: ts.SourceFile;
}

export interface CompileTypeScriptModulesOptions<BackendOptions> extends Omit<
  CompileModulesOptions<BackendOptions>,
  'modules'
> {
  sources: readonly TypeScriptModuleInput[];
}

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
  if (diagnostics.length > 0) throw new CompilerDiagnosticsError(diagnostics);
  return compileModules({
    backend: options.backend,
    backendOptions: options.backendOptions,
    modules: lowered.map((result) => result.module),
    ...(options.patches ? { patches: options.patches } : {}),
  });
}

export function parseTypeScriptSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export class CompilerDiagnosticsError extends Error {
  constructor(readonly diagnostics: readonly CompilerDiagnostic[]) {
    super(
      `TypeScript lowering produced ${String(diagnostics.length)} diagnostic(s):\n${diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.source}:${String(diagnostic.line)}:${String(diagnostic.column)} [${diagnostic.code}] ${diagnostic.message}`,
        )
        .join('\n')}`,
    );
  }
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
    if (paths.has(file.path)) throw new Error(`Backend emitted duplicate file path: ${file.path}`);
    paths.add(file.path);
  }
}

function validateModuleIdentities(modules: readonly IrModule[]): void {
  const identities = new Set<string>();
  for (const module of modules) {
    const identity = `${module.packageName}\0${module.source}\0${module.name}`;
    if (identities.has(identity))
      throw new Error(`Duplicate compiler module identity: ${module.packageName}/${module.source}`);
    identities.add(identity);
  }
}

export { fingerprintText, fingerprintTypeScriptNode, normalizeTypeScriptNode } from './analyze/fingerprint.ts';
export {
  analyzeFlightWorkspace,
  packageRootExportLane,
  readGitCommit,
  readPackageExportManifest,
  resolvePackageExportLane,
} from './analyze/inventory.ts';
export { createTypeScriptProject } from './analyze/program.ts';
export {
  declarationEmitsRuntimeBinding,
  isExplicitTypeOnlyExport,
  runtimeBindingDeclaration,
  runtimeExportsForSource,
} from './analyze/runtimeValues.ts';
export { lowerTypeScriptSource } from './analyze/typescript.ts';
export { BackendEmissionError } from './backend/emission.ts';
export {
  haxeBackend,
  emitHaxeModule,
  packageNameToHaxePackage,
  sourcePathToHaxeModule,
} from './backends/haxe/backend.ts';
export {
  rustBackend,
  emitRustModule,
  packageNameToRustCrate,
  sourcePathToRustModule,
} from './backends/rust/backend.ts';
export {
  compileModules,
  CompilerDiagnosticsError,
  compileTypeScriptModules,
  parseTypeScriptSource,
} from './compiler/compile.ts';
export { applySemanticPatches, defineSemanticPatches } from './patch/apply.ts';

export type { PackageExportDescriptor } from './analyze/inventory.ts';
export type { TypeScriptProject } from './analyze/program.ts';
export type { RuntimeExportDecision } from './analyze/runtimeValues.ts';
export type { LowerTypeScriptSourceOptions } from './analyze/typescript.ts';
export type { HaxeBackendOptions } from './backends/haxe/backend.ts';
export type { RustBackendOptions } from './backends/rust/backend.ts';
export type { CompileTypeScriptModulesOptions, TypeScriptModuleInput } from './compiler/compile.ts';
export type * from './model/backend.ts';
export type * from './model/compiler.ts';
export type * from './model/inventory.ts';
export type * from './model/ir.ts';
export type * from './model/patch.ts';
export type { AppliedSemanticPatches } from './patch/apply.ts';

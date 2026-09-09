export {
  compileIrModules,
  compileTypeScriptModules,
  createCompilerDiagnosticsFailure,
  isCompilerDiagnosticsFailure,
  parseTypeScriptSource,
} from './compilerOrchestration.js';
export { compileTypeScriptPackageGraph, isCompilerPackageGraphFailure } from './compilerPackageCompilation.js';

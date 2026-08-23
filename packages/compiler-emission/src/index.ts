export { collectIrModuleNullableBindingIds, hasIrTypeAbsentMember } from './compilerNullableFlowGuard.js';
export { createCompilerGeneratedFileHeader } from './compilerGeneratedFileProvenance.js';
export { createCompilerModuleFacadeIdentities, isCompilerModuleFacadeFailure } from './compilerModuleFacadeIdentity.js';
export {
  isCompilerEmittedSourceSyntaxFailure,
  validateCompilerEmittedSourceSyntax,
} from './compilerEmittedSourceSyntax.js';
export {
  isCompilerTargetCompilationSmokeFailure,
  validateCompilerTargetCompilationSmoke,
} from './compilerTargetCompilationSmoke.js';
export {
  createBackendEmissionFailure,
  createCompilerInvariantFailure,
  convertEmittedFileContentsToUtf8,
  indentSourceLines,
  normalizeSourceTextGrouping,
  isBackendEmissionFailure,
  isCompilerInvariantFailure,
  normalizeEmittedFile,
  normalizeEmittedFileContents,
  normalizeEmittedFilePath,
} from './compilerSourceEmission.js';
export {
  createCompilerTargetNameAllocation,
  createIrModuleTargetNameAllocation,
  isCompilerTargetNameAllocationFailure,
} from './compilerTargetNameAllocation.js';

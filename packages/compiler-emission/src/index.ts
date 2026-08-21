export { createCompilerGeneratedFileHeader } from './compilerGeneratedFileProvenance.js';
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

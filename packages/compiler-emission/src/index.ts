export {
  createBackendEmissionFailure,
  createCompilerInvariantFailure,
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

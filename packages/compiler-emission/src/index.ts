export { createCompilerGeneratedFileHeader } from './compilerGeneratedFileProvenance.js';
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

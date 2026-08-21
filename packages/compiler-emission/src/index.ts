export { createCompilerGeneratedFileHeader } from './compilerGeneratedFileProvenance.js';
export {
  isCompilerEmittedSourceConformanceFailure,
  validateCompilerEmittedSourceConformance,
} from './compilerEmittedSourceConformance.js';
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

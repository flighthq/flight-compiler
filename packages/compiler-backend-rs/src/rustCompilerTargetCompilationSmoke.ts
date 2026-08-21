import type { CompilerTargetCompilationSmoke } from '../../compiler-types/src/index.js';

export function createRustCompilerTargetCompilationSmoke(
  compileEmittedSources: CompilerTargetCompilationSmoke['compileEmittedSources'],
): CompilerTargetCompilationSmoke {
  return {
    compileEmittedSources,
    name: 'rust',
    supportsEmittedSource: (file) => file.path.endsWith('.rs'),
  };
}

import type { CompilerTargetCompilationSmoke } from '../../compiler-types/src/index.js';

export function createHaxeCompilerTargetCompilationSmoke(
  compileEmittedSources: CompilerTargetCompilationSmoke['compileEmittedSources'],
): CompilerTargetCompilationSmoke {
  return {
    compileEmittedSources,
    name: 'haxe',
    supportsEmittedSource: (file) => file.path.endsWith('.hx'),
  };
}

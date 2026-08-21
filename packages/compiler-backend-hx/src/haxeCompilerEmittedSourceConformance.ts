import type { CompilerEmittedSourceParser } from '../../compiler-types/src/index.js';

export function createHaxeCompilerEmittedSourceParser(
  parseEmittedSource: CompilerEmittedSourceParser['parseEmittedSource'],
): CompilerEmittedSourceParser {
  return {
    name: 'haxe',
    parseEmittedSource,
    supportsEmittedSource: (file) => file.path.endsWith('.hx'),
  };
}

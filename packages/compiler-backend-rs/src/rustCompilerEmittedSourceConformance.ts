import type { CompilerEmittedSourceParser } from '../../compiler-types/src/index.js';

export function createRustCompilerEmittedSourceParser(
  parseEmittedSource: CompilerEmittedSourceParser['parseEmittedSource'],
): CompilerEmittedSourceParser {
  return {
    name: 'rust',
    parseEmittedSource,
    supportsEmittedSource: (file) => file.path.endsWith('.rs'),
  };
}

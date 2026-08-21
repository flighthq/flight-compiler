import ts from 'typescript';

import { validateCompilerEmittedSourceConformance } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleRust } from './rustCompilerBackend.js';
import { createRustCompilerEmittedSourceParser } from './rustCompilerEmittedSourceConformance.js';

describe('createRustCompilerEmittedSourceParser', () => {
  it('adapts a parser callback to exact Rust emitted-file selection and conformance reporting', () => {
    const seen: string[] = [];
    const parser = createRustCompilerEmittedSourceParser((file) => {
      seen.push(file.path);
      return [];
    });
    const module = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/math/src/value.ts',
        'export const value = 1;',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/math', upstreamDirectory: '/flight' },
    ).module;
    const emitted = emitIrModuleRust(module);

    expect(parser.name).toBe('rust');
    expect(
      validateCompilerEmittedSourceConformance(
        [
          emitted,
          { contents: 'pub struct Upper {}', path: 'flight/upper.RS' },
          { contents: 'package flight; class Value {}', path: 'flight/Value.hx' },
        ],
        parser,
      ),
    ).toEqual({ checkedFiles: 1, parser: 'rust', skippedFiles: ['flight/Value.hx', 'flight/upper.RS'] });
    expect(seen).toEqual(['value.rs']);
  });
});

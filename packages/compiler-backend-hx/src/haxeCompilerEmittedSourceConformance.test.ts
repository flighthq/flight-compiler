import ts from 'typescript';

import { validateCompilerEmittedSourceConformance } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleHaxe } from './haxeCompilerBackend.js';
import { createHaxeCompilerEmittedSourceParser } from './haxeCompilerEmittedSourceConformance.js';

describe('createHaxeCompilerEmittedSourceParser', () => {
  it('adapts a parser callback to exact Haxe emitted-file selection and conformance reporting', () => {
    const seen: string[] = [];
    const parser = createHaxeCompilerEmittedSourceParser((file) => {
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
    const emitted = emitIrModuleHaxe(module);

    expect(parser.name).toBe('haxe');
    expect(
      validateCompilerEmittedSourceConformance(
        [
          emitted,
          { contents: 'class Upper {}', path: 'flight/Upper.HX' },
          { contents: 'pub struct Value {}', path: 'flight/value.rs' },
        ],
        parser,
      ),
    ).toEqual({ checkedFiles: 1, parser: 'haxe' });
    expect(seen).toEqual(['flighthq/math/Value.hx']);
  });
});

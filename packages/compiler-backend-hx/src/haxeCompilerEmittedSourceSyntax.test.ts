import ts from 'typescript';

import { validateCompilerEmittedSourceSyntax } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleHaxe } from './haxeCompilerBackend.js';
import { createHaxeCompilerEmittedSourceParser } from './haxeCompilerEmittedSourceSyntax.js';

describe('createHaxeCompilerEmittedSourceParser', () => {
  it('adapts a parser callback to exact Haxe emitted-file selection and syntax reporting', () => {
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
      validateCompilerEmittedSourceSyntax(
        [
          emitted,
          { contents: 'class Upper {}', path: 'flight/Upper.HX' },
          { contents: 'pub struct Value {}', path: 'flight/value.rs' },
        ],
        parser,
      ),
    ).toEqual({ checkedFiles: 1, parser: 'haxe', skippedFiles: ['flight/Upper.HX', 'flight/value.rs'] });
    expect(seen).toEqual(['flighthq/math/Value.hx']);
  });

  it('passes emitted task callback syntax to the injected Haxe parser', () => {
    const module = lowerTypeScriptSource(
      ts.createSourceFile(
        '/flight/packages/task/src/task.ts',
        'export async function task(input: Promise<number>): Promise<number> { return await input; }',
        ts.ScriptTarget.Latest,
        true,
      ),
      { packageName: '@flighthq/task', upstreamDirectory: '/flight' },
    ).module;
    const emitted = emitIrModuleHaxe(module);
    const parser = createHaxeCompilerEmittedSourceParser((file) => {
      expect(file.contents).toContain('new flighthq._internal._Promise(function(resolveTask, rejectTask)');
      expect(file.contents).toContain('.resolve(input).then(');
      expect(file.contents).not.toContain('await ');
      return [];
    });

    expect(validateCompilerEmittedSourceSyntax([emitted], parser)).toEqual({
      checkedFiles: 1,
      parser: 'haxe',
      skippedFiles: [],
    });
  });
});

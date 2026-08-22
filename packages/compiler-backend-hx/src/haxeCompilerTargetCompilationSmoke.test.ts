import ts from 'typescript';

import { validateCompilerTargetCompilationSmoke } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleHaxe } from './haxeCompilerBackend.js';
import { createHaxeCompilerTargetCompilationSmoke } from './haxeCompilerTargetCompilationSmoke.js';

describe('createHaxeCompilerTargetCompilationSmoke', () => {
  it('creates an exact-extension Haxe compiler adapter over the injected batch compiler', () => {
    const compileEmittedSources = () => [];
    const compiler = createHaxeCompilerTargetCompilationSmoke(compileEmittedSources);

    expect(compiler.name).toBe('haxe');
    expect(compiler.compileEmittedSources).toBe(compileEmittedSources);
    expect(compiler.supportsEmittedSource({ path: 'flight/Value.hx' })).toBe(true);
    expect(compiler.supportsEmittedSource({ path: 'flight/Value.HX' })).toBe(false);
    expect(compiler.supportsEmittedSource({ path: 'flight/value.rs' })).toBe(false);
  });

  it('creates independent adapter records', () => {
    const first = createHaxeCompilerTargetCompilationSmoke(() => []);
    const second = createHaxeCompilerTargetCompilationSmoke(() => []);

    expect(first).not.toBe(second);
  });

  it('passes the complete emitted task file set to the injected Haxe compiler', () => {
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
    const compiler = createHaxeCompilerTargetCompilationSmoke((files) => {
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(emitted.path);
      expect(files[0]?.contents).toContain('.resolve(input).then(');
      return [];
    });

    expect(validateCompilerTargetCompilationSmoke([emitted], compiler)).toEqual({
      checkedFiles: 1,
      compiler: 'haxe',
      skippedFiles: [],
    });
  });
});

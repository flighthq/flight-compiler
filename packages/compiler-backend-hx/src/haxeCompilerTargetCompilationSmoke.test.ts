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
});

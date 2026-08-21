import { createRustCompilerTargetCompilationSmoke } from './rustCompilerTargetCompilationSmoke.js';

describe('createRustCompilerTargetCompilationSmoke', () => {
  it('creates an exact-extension Rust compiler adapter over the injected batch compiler', () => {
    const compileEmittedSources = () => [];
    const compiler = createRustCompilerTargetCompilationSmoke(compileEmittedSources);

    expect(compiler.name).toBe('rust');
    expect(compiler.compileEmittedSources).toBe(compileEmittedSources);
    expect(compiler.supportsEmittedSource({ path: 'flight/value.rs' })).toBe(true);
    expect(compiler.supportsEmittedSource({ path: 'flight/value.RS' })).toBe(false);
    expect(compiler.supportsEmittedSource({ path: 'flight/Value.hx' })).toBe(false);
  });

  it('creates independent adapter records', () => {
    const first = createRustCompilerTargetCompilationSmoke(() => []);
    const second = createRustCompilerTargetCompilationSmoke(() => []);

    expect(first).not.toBe(second);
  });
});

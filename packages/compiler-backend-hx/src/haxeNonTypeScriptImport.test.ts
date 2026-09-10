import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { emitIrModuleHaxe } from './haxeCompilerBackend.js';

describe('Haxe non-TypeScript imports', () => {
  it.each([
    ['value import', "import shader from './shader.wgsl'; export const value = shader;", './shader.wgsl'],
    ['side-effect import', "import './runtime.wasm'; export const value = 1;", './runtime.wasm'],
    ['re-export', "export { schema } from './schema.json';", './schema.json'],
  ])('refuses an unmaterialized %s as a controlled backend capability gap', (_, source, specifier) => {
    const result = lowerTypeScriptSource(
      ts.createSourceFile('/flight/packages/assets/src/value.ts', source, ts.ScriptTarget.Latest, true),
      { packageName: '@flighthq/assets', upstreamDirectory: '/flight' },
    );

    let error: unknown;
    try {
      emitIrModuleHaxe(result.module);
    } catch (caught) {
      error = caught;
    }

    expect(isBackendEmissionFailure(error)).toBe(true);
    if (isBackendEmissionFailure(error)) {
      expect(error).toMatchObject({
        backend: 'haxe',
        code: 'unsupported-ir',
        message: expect.stringContaining(`non-TypeScript import ${specifier} requires resource materialization`),
      });
    }
  });
});

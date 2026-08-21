import type {
  BackendEmissionFailure,
  BackendCompilation,
  BackendEmitContext,
  CompilerBackend,
  EmittedFile,
  EmittedFileIdentity,
  HaxeCompilerBackendOptions,
  RustCompilerBackendOptions,
} from './compilerBackendContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerSourceIdentity } from './compilerSourceIdentity.js';

describe('compiler backend contracts', () => {
  it('represent backend capabilities, options, and output as plain composable data', () => {
    const module = createModule();
    const haxeOptions: HaxeCompilerBackendOptions = { rootPackage: 'flighthq', upstreamCommit: 'a'.repeat(40) };
    const rustOptions: RustCompilerBackendOptions = {
      opaqueHostType: 'FlightHostValue',
      upstreamCommit: 'a'.repeat(40),
    };
    const context: BackendEmitContext<HaxeCompilerBackendOptions> = { modules: [module], options: haxeOptions };
    const file: EmittedFile = { contents: 'value', path: 'Value.hx' };
    const backend: CompilerBackend<HaxeCompilerBackendOptions> = {
      emitModule: (_module, received) => (received.options.rootPackage ? [file] : []),
      name: 'haxe',
    };
    const compilation: BackendCompilation = { backend: backend.name, files: [...backend.emitModule(module, context)] };

    expect(compilation).toEqual({ backend: 'haxe', files: [file] });
    expect(rustOptions).toEqual({ opaqueHostType: 'FlightHostValue', upstreamCommit: 'a'.repeat(40) });
    expectTypeOf<BackendEmissionFailure>().toMatchTypeOf<CompilerSourceIdentity>();
    expectTypeOf<EmittedFile>().toMatchTypeOf<EmittedFileIdentity>();
  });
});

function createModule(): IrModule {
  return {
    declarations: [],
    exports: [],
    imports: [],
    name: 'Value',
    packageName: '@flighthq/math',
    source: 'packages/math/src/value.ts',
  };
}

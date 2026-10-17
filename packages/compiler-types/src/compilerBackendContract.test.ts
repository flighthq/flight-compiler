import type {
  BackendEmissionFailure,
  BackendCompilation,
  BackendEmitContext,
  CompilerBackend,
  CompilerBackendEmissionSession,
  CompilerBackendPackageGraphFinalization,
  CppCompilerBackendOptions,
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
    const haxeOptions: HaxeCompilerBackendOptions = {
      emissionMode: 'extern',
      rootPackage: 'flighthq',
      upstreamCommit: 'a'.repeat(40),
    };
    const rustOptions: RustCompilerBackendOptions = {
      hostBindings: {
        bindings: [
          {
            nullability: 'non-null',
            ownership: 'shared',
            sourceName: 'Blob',
            space: 'type',
            targetName: 'flight_host::Blob',
          },
        ],
        schema: 'flight-rust-external-bindings/1',
      },
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
    expect(rustOptions).toEqual({
      hostBindings: {
        bindings: [
          {
            nullability: 'non-null',
            ownership: 'shared',
            sourceName: 'Blob',
            space: 'type',
            targetName: 'flight_host::Blob',
          },
        ],
        schema: 'flight-rust-external-bindings/1',
      },
      opaqueHostType: 'FlightHostValue',
      upstreamCommit: 'a'.repeat(40),
    });
    const cppOptions: CppCompilerBackendOptions = {
      cAbi: {
        adapterSourcePath: 'generated/types_c.cpp',
        headerPath: 'include/types_c.h',
        packageName: '@flighthq/types',
      },
      externalBindings: {
        bindings: [
          {
            callResultType: 'host::TimerHandle',
            headers: ['host/timer.hpp'],
            nullability: 'non-null',
            ownership: 'value',
            sourceName: 'setTimeout',
            space: 'value',
            targetName: 'host::set_timeout',
          },
          {
            headers: ['host/gl.hpp'],
            members: [
              {
                callResultAbsence: 'null',
                callResultType: 'std::optional<host::GlExtension>',
                recordConversion: {
                  invocation: 'carrier-function',
                  keyType: 'string',
                  resultNullability: 'nullable',
                  resultOwnership: 'value',
                  targetName: 'host::gl_extension_record',
                  valueType: 'number',
                },
                sourceMember: 'getExtension',
                targetName: 'get_extension',
              },
            ],
            nullability: 'non-null',
            ownership: 'shared',
            sourceName: 'WebGL2RenderingContext',
            space: 'type',
            targetName: 'host::GlContext&',
            weakKeyPolicyTargetName: 'host::GlContextWeakKeyPolicy',
          },
        ],
        schema: 'flight-cpp-external-bindings/1',
      },
      packageTargets: {
        '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
      },
      runtimeHeader: 'flight_runtime.h',
      runtimeProfile: 'flight-cpp',
      upstreamCommit: 'a'.repeat(40),
    };
    expect(cppOptions).toEqual({
      cAbi: {
        adapterSourcePath: 'generated/types_c.cpp',
        headerPath: 'include/types_c.h',
        packageName: '@flighthq/types',
      },
      externalBindings: {
        bindings: [
          {
            callResultType: 'host::TimerHandle',
            headers: ['host/timer.hpp'],
            nullability: 'non-null',
            ownership: 'value',
            sourceName: 'setTimeout',
            space: 'value',
            targetName: 'host::set_timeout',
          },
          {
            headers: ['host/gl.hpp'],
            members: [
              {
                callResultAbsence: 'null',
                callResultType: 'std::optional<host::GlExtension>',
                recordConversion: {
                  invocation: 'carrier-function',
                  keyType: 'string',
                  resultNullability: 'nullable',
                  resultOwnership: 'value',
                  targetName: 'host::gl_extension_record',
                  valueType: 'number',
                },
                sourceMember: 'getExtension',
                targetName: 'get_extension',
              },
            ],
            nullability: 'non-null',
            ownership: 'shared',
            sourceName: 'WebGL2RenderingContext',
            space: 'type',
            targetName: 'host::GlContext&',
            weakKeyPolicyTargetName: 'host::GlContextWeakKeyPolicy',
          },
        ],
        schema: 'flight-cpp-external-bindings/1',
      },
      packageTargets: {
        '@flighthq/types': { includePrefix: 'flight/types', namespace: 'flight::types' },
      },
      runtimeHeader: 'flight_runtime.h',
      runtimeProfile: 'flight-cpp',
      upstreamCommit: 'a'.repeat(40),
    });
    expectTypeOf<BackendEmissionFailure>().toMatchTypeOf<CompilerSourceIdentity>();
    expectTypeOf<EmittedFile>().toMatchTypeOf<EmittedFileIdentity>();
  });

  it('represents final package-graph facts and package-owned output as plain composable data', () => {
    const module = createModule();
    const identity = { name: module.name, packageName: module.packageName, source: module.source };
    const finalization: CompilerBackendPackageGraphFinalization = {
      facade: {
        modules: [{ module: identity, slots: [] }],
        schema: 'flight-compiler-module-facade/1',
        semantics: {
          bindingAccess: 'live',
          explicitPrecedence: 'named-over-star',
          starAmbiguity: 'refuse-distinct-resolutions',
          starDefault: 'excluded',
          typeValueLanes: 'independent',
        },
      },
      moduleFiles: [{ file: { contents: 'module', path: 'module.rs' }, module: identity }],
    };
    const session: CompilerBackendEmissionSession = {
      emitModule: () => [],
      finalizePackageGraph: ({ facade, moduleFiles }) => ({
        moduleFileReplacements: moduleFiles.map(({ file: retained, module: owner }) => ({
          file: { contents: 'final module', path: 'final/module.rs' },
          module: owner,
          retainedPath: retained.path,
        })),
        packageFiles: [
          {
            file: { contents: facade.schema, path: 'package.txt' },
            owner: { kind: 'package', packageName: moduleFiles[0]!.module.packageName },
            provenance: moduleFiles.map(({ module: owner }) => owner),
          },
        ],
      }),
    };

    expect(session.finalizePackageGraph?.(finalization)).toEqual({
      moduleFileReplacements: [
        {
          file: { contents: 'final module', path: 'final/module.rs' },
          module: identity,
          retainedPath: 'module.rs',
        },
      ],
      packageFiles: [
        {
          file: { contents: 'flight-compiler-module-facade/1', path: 'package.txt' },
          owner: { kind: 'package', packageName: '@flighthq/math' },
          provenance: [identity],
        },
      ],
    });
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

import { createBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { createMemoryWorkspaceSource } from '../../compiler-inventory/src/index.js';
import type { CompilerBackend } from '../../compiler-types/src/index.js';
import { compileFlightWorkspace } from './flightWorkspaceCompilation.js';

describe('compileFlightWorkspace', () => {
  it('compiles the selected workspace with complete direct and dependency refusal reporting', () => {
    const files = createWorkspaceFiles();
    const snapshot = structuredClone(files);
    const sessionOptions: unknown[] = [];
    const backend: CompilerBackend<{ readonly runtimeProfile: string }> = {
      createEmissionSession(context) {
        sessionOptions.push(context.options);
        return {
          emitModule(module) {
            if (module.name === 'Broken') {
              throw createBackendEmissionFailure('fixture', module, 'broken is deliberately unsupported');
            }
            return [
              { contents: module.name, path: `${module.packageName.slice('@flighthq/'.length)}/${module.name}.txt` },
            ];
          },
        };
      },
      emitModule: () => {
        throw new Error('workspace compilation must reuse one package-graph emission session');
      },
      name: 'fixture',
    };

    const result = compileFlightWorkspace({
      backend,
      backendOptions: { runtimeProfile: 'fixture-runtime/1' },
      eligiblePackageNames: ['@flighthq/app', '@flighthq/base'],
      patches: [],
      source: createMemoryWorkspaceSource(files),
      upstreamDirectory: '/flight',
    });

    expect(sessionOptions).toEqual([{ runtimeProfile: 'fixture-runtime/1' }]);
    expect(
      result.report.modules.map((module) => [module.module.packageName, module.module.name, module.status]),
    ).toEqual([
      ['@flighthq/app', 'Consumer', 'refused'],
      ['@flighthq/app', 'Helper', 'emitted'],
      ['@flighthq/app', 'Index', 'refused'],
      ['@flighthq/base', 'Broken', 'refused'],
      ['@flighthq/base', 'Index', 'refused'],
      ['@flighthq/base', 'Stable', 'emitted'],
    ]);
    expect(refusal(result, '@flighthq/base', 'Broken')).toMatchObject({
      code: 'unsupported-ir',
      stage: 'emission',
    });
    expect(refusal(result, '@flighthq/app', 'Consumer')).toMatchObject({
      code: 'dependency-refused',
      refusedDependencies: ['@flighthq/base/packages/base/src/broken.ts'],
      stage: 'dependency',
    });
    expect(refusal(result, '@flighthq/app', 'Index')).toMatchObject({
      code: 'dependency-refused',
      stage: 'dependency',
    });
    expect(result.compilation.files.map((file) => file.path)).toEqual(['app/Helper.txt', 'base/Stable.txt']);
    expect(files).toEqual(snapshot);
  });

  it('keeps reports deterministic when package selection and workspace enumeration are reordered', () => {
    const files = createWorkspaceFiles();
    const backend: CompilerBackend = {
      emitModule: (module) => [{ contents: module.name, path: `${module.packageName}/${module.name}.txt` }],
      name: 'fixture',
    };
    const compile = (eligiblePackageNames: readonly string[], workspaceFiles: Readonly<Record<string, string>>) =>
      compileFlightWorkspace({
        backend,
        backendOptions: {},
        eligiblePackageNames,
        source: createMemoryWorkspaceSource(workspaceFiles),
        upstreamDirectory: '/flight',
      });

    const first = compile(['@flighthq/app', '@flighthq/base'], files);
    const second = compile(['@flighthq/base', '@flighthq/app'], Object.fromEntries(Object.entries(files).reverse()));

    expect(first).toEqual(second);
  });
});

function createPackageManifest(name: string, dependencies: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({
    dependencies,
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
    },
    name,
    version: '1.0.0',
  });
}

function createWorkspaceFiles(): Record<string, string> {
  return {
    '/flight/packages/app/package.json': createPackageManifest('@flighthq/app', { '@flighthq/base': '*' }),
    '/flight/packages/app/src/consumer.ts':
      "import { broken } from '@flighthq/base'; import { helper } from './helper.js'; export const result = broken + helper;",
    '/flight/packages/app/src/helper.ts': 'export const helper = 3;',
    '/flight/packages/app/src/index.ts': "export { result } from './consumer.js';",
    '/flight/packages/base/package.json': createPackageManifest('@flighthq/base'),
    '/flight/packages/base/src/broken.ts': 'export const broken = 2;',
    '/flight/packages/base/src/index.ts': "export { broken } from './broken.js'; export { stable } from './stable.js';",
    '/flight/packages/base/src/stable.ts': 'export const stable = 1;',
  };
}

function refusal(result: ReturnType<typeof compileFlightWorkspace>, packageName: string, moduleName: string) {
  return result.report.modules.find(
    (module) => module.module.packageName === packageName && module.module.name === moduleName,
  )?.refusals[0];
}

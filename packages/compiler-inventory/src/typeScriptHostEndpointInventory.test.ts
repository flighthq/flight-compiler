import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import type { FlightPackageManifest } from '../../compiler-types/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { analyzeTypeScriptHostEndpoints } from './typeScriptHostEndpointInventory.js';
import { createTypeScriptProject } from './typeScriptProject.js';

describe('analyzeTypeScriptHostEndpoints', () => {
  it('groups checker-resolved production endpoint uses with portable deterministic sites', () => {
    const fixture = createHostEndpointFixture();
    try {
      const project = createTypeScriptProject(path.join(fixture.directory, 'tsconfig.json'));
      const manifests = [fixture.manifest];
      const snapshot = structuredClone(manifests);
      const source = project.program.getSourceFile(path.join(fixture.directory, 'packages/web/src/index.ts'))!;
      const elementAccess = findTypeScriptElementAccess(source);

      expect(Object.hasOwn(elementAccess, 'name')).toBe(false);
      const options = {
        manifests,
        project,
        resolveReceiver: (type: ts.Type, checker: ts.TypeChecker) =>
          checker.typeToString(type) === 'HostApi' ? 'web.host' : undefined,
        upstreamDirectory: fixture.directory,
      };
      const inventory = analyzeTypeScriptHostEndpoints(options);

      expect(inventory).toEqual({
        endpoints: [
          {
            endpoint: 'Factory',
            operation: 'construct',
            receiver: 'web.host',
            sites: [
              {
                column: 11,
                line: 11,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'label',
            operation: 'read',
            receiver: 'web.host',
            sites: [
              {
                column: 6,
                line: 12,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'optional',
            operation: 'write',
            receiver: 'web.host',
            sites: [
              {
                column: 13,
                line: 9,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'run',
            operation: 'call',
            receiver: 'web.host',
            sites: [
              {
                column: 7,
                line: 10,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'value',
            operation: 'read',
            receiver: 'web.host',
            sites: [
              {
                column: 6,
                line: 4,
                packageName: '@flighthq/web',
                source: 'packages/web/src/extra.ts',
              },
              {
                column: 6,
                line: 4,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'value',
            operation: 'readWrite',
            receiver: 'web.host',
            sites: [
              {
                column: 6,
                line: 6,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
              {
                column: 6,
                line: 7,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
              {
                column: 8,
                line: 8,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
          {
            endpoint: 'value',
            operation: 'write',
            receiver: 'web.host',
            sites: [
              {
                column: 7,
                line: 5,
                packageName: '@flighthq/web',
                source: 'packages/web/src/index.ts',
              },
            ],
          },
        ],
        schema: 'flight-compiler-host-endpoints/1',
        summary: { endpoints: 7, uses: 10 },
      });
      expect(analyzeTypeScriptHostEndpoints(options)).toEqual(inventory);
      expect(manifests).toEqual(snapshot);
      expect(Object.hasOwn(elementAccess, 'name')).toBe(false);
    } finally {
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it('rejects an empty receiver identity with a tagged failure', () => {
    const fixture = createHostEndpointFixture();
    try {
      const project = createTypeScriptProject(path.join(fixture.directory, 'tsconfig.json'));
      let failure: unknown;
      try {
        analyzeTypeScriptHostEndpoints({
          manifests: [fixture.manifest],
          project,
          resolveReceiver: () => ' ',
          upstreamDirectory: fixture.directory,
        });
      } catch (error) {
        failure = error;
      }

      expect(isCompilerInventoryFailure(failure)).toBe(true);
      expect(failure).toMatchObject({ code: 'invalid-host-endpoint-receiver', kind: 'compiler-inventory' });
    } finally {
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it('returns an empty versioned inventory when no receiver type matches', () => {
    const fixture = createHostEndpointFixture();
    try {
      const project = createTypeScriptProject(path.join(fixture.directory, 'tsconfig.json'));

      expect(
        analyzeTypeScriptHostEndpoints({
          manifests: [fixture.manifest],
          project,
          resolveReceiver: () => undefined,
          upstreamDirectory: fixture.directory,
        }),
      ).toEqual({
        endpoints: [],
        schema: 'flight-compiler-host-endpoints/1',
        summary: { endpoints: 0, uses: 0 },
      });
    } finally {
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });
});

function createHostEndpointFixture(): { directory: string; manifest: FlightPackageManifest } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-host-endpoints-'));
  write(
    directory,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['packages/**/*.ts'] }),
  );
  const declarations = [
    'interface Constructable { new(): unknown }',
    'interface HostApi { Factory: Constructable; label: string; optional?: number; run(): void; value: number }',
    'declare const host: HostApi;',
  ].join('\n');
  write(
    directory,
    'packages/web/src/index.ts',
    `${declarations}\nhost.value;\n(host.value) = 1;\nhost.value += 2;\nhost.value++;\n++host.value;\ndelete host.optional;\n(host.run)();\nnew (host.Factory)();\nhost['label'];\nhost[dynamic];\n`,
  );
  write(directory, 'packages/web/src/extra.ts', `${declarations}\nhost.value;\n`);
  write(directory, 'packages/web/src/index.test.ts', `${declarations}\nhost.value;\n`);
  write(directory, 'packages/web/src/ambient.d.ts', `${declarations}\nhost.value;\n`);
  return {
    directory,
    manifest: {
      bins: [],
      dependencies: [],
      directory: 'packages/web',
      name: '@flighthq/web',
      version: '0.0.0',
    },
  };
}

function findTypeScriptElementAccess(source: ts.SourceFile): ts.ElementAccessExpression {
  let found: ts.ElementAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isElementAccessExpression(node)) found = node;
    node.forEachChild(visit);
  };
  visit(source);
  if (!found) throw new Error('Expected fixture element access');
  return found;
}

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

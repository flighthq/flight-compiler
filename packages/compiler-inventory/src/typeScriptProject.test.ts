import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { isCompilerInventoryFailure } from './compilerInventoryFailure.js';
import { createTypeScriptProject } from './typeScriptProject.js';

// Constructing a real TypeScript program loads and checks the standard library, and v8 coverage
// instrumentation roughly doubles that cost: measured at 29s with the default type surface and 12.8s
// after `skipLibCheck` and an empty `types` list. The explicit ceiling belongs here rather than in the
// shared Vitest default, so one genuinely expensive fixture does not buy every other test the right to
// hang. Neither option weakens the claim: the project is still strict and still asserted to produce no
// syntactic or semantic diagnostics.
const typeScriptProgramTimeoutMs = 60_000;

describe('createTypeScriptProject', () => {
  it(
    'constructs one strict project, checker, and compiler-option identity from a configuration',
    () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-typescript-project-'));
      try {
        write(directory, 'src/value.ts', 'export const value: number = 1;\n');
        write(
          directory,
          'tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              skipLibCheck: true,
              strict: true,
              target: 'ES2022',
              types: [],
            },
            include: ['src/**/*.ts'],
          }),
        );

        const project = createTypeScriptProject(path.join(directory, 'tsconfig.json'));
        const source = project.program.getSourceFile(path.join(directory, 'src', 'value.ts'));

        expect(source && normalizePathPortable(source.fileName)).toBe(
          normalizePathPortable(path.join(directory, 'src', 'value.ts')),
        );
        expect(project.checker).toBe(project.program.getTypeChecker());
        expect(project.options.strict).toBe(true);
        expect(project.program.getSyntacticDiagnostics()).toEqual([]);
        expect(project.program.getSemanticDiagnostics()).toEqual([]);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    typeScriptProgramTimeoutMs,
  );

  it(
    'forwards project references when the configuration declares them',
    () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-typescript-project-refs-'));
      try {
        write(directory, 'packages/types/src/value.ts', 'export const value: number = 1;\n');
        write(
          directory,
          'packages/types/tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              composite: true,
              module: 'ESNext',
              moduleResolution: 'Bundler',
              skipLibCheck: true,
              strict: true,
              target: 'ES2022',
              types: [],
            },
            include: ['src/**/*.ts'],
          }),
        );
        write(directory, 'packages/app/src/index.ts', 'export const entry = 1;\n');
        write(
          directory,
          'packages/app/tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'Bundler',
              skipLibCheck: true,
              strict: true,
              target: 'ES2022',
              types: [],
            },
            include: ['src/**/*.ts'],
            references: [{ path: '../types' }],
          }),
        );

        const project = createTypeScriptProject(path.join(directory, 'packages/app/tsconfig.json'));

        expect(project.options.strict).toBe(true);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    typeScriptProgramTimeoutMs,
  );

  it('fails loudly for missing and malformed configuration files', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-typescript-project-invalid-'));
    try {
      write(directory, 'tsconfig.json', '{ invalid json');

      for (const file of ['missing.json', 'tsconfig.json']) {
        let failure: unknown;
        try {
          createTypeScriptProject(path.join(directory, file));
        } catch (error) {
          failure = error;
        }
        expect(isCompilerInventoryFailure(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'invalid-typescript-project', kind: 'compiler-inventory' });
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function write(directory: string, file: string, contents: string): void {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTypeScriptProject } from './typeScriptProject.js';

describe('createTypeScriptProject', () => {
  it('constructs one strict project, checker, and compiler-option identity from a configuration', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-typescript-project-'));
    try {
      write(directory, 'src/value.ts', 'export const value: number = 1;\n');
      write(
        directory,
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, target: 'ES2022' },
          include: ['src/**/*.ts'],
        }),
      );

      const project = createTypeScriptProject(path.join(directory, 'tsconfig.json'));
      const source = project.program.getSourceFile(path.join(directory, 'src', 'value.ts'));

      expect(source?.fileName.replaceAll('\\', '/')).toBe(
        path.join(directory, 'src', 'value.ts').replaceAll('\\', '/'),
      );
      expect(project.checker).toBe(project.program.getTypeChecker());
      expect(project.options.strict).toBe(true);
      expect(project.program.getSyntacticDiagnostics()).toEqual([]);
      expect(project.program.getSemanticDiagnostics()).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('fails loudly for missing and malformed configuration files', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'flight-compiler-typescript-project-invalid-'));
    try {
      write(directory, 'tsconfig.json', '{ invalid json');

      expect(() => createTypeScriptProject(path.join(directory, 'missing.json'))).toThrow();
      expect(() => createTypeScriptProject(path.join(directory, 'tsconfig.json'))).toThrow();
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

import type { CompilerLoweringFailureCode, CompilerLoweringPass, IrModule } from '../../compiler-types/src/index.js';
import {
  createCompilerLoweringFailure,
  isCompilerLoweringFailure,
  lowerIrModuleWithCompilerPasses,
} from './compilerLoweringPass.js';

describe('createCompilerLoweringFailure', () => {
  it('creates an inspectable pass-named failure with source identity and cause', () => {
    const cause = new Error('fixture cause');
    const failure = createCompilerLoweringFailure('malformed-ir', 'fixture-pass', module, 'invalid output', cause);

    expect(failure).toMatchObject({
      cause,
      code: 'malformed-ir',
      kind: 'compiler-lowering',
      name: 'CompilerLoweringError',
      packageName: '@flighthq/math',
      pass: 'fixture-pass',
      source: 'src/value.ts',
    });
    expect(failure.message).toContain('fixture-pass failed for @flighthq/math/src/value.ts: invalid output');
  });
});

describe('isCompilerLoweringFailure', () => {
  it('accepts every stable code and rejects unknown or incomplete failures', () => {
    const codes: readonly CompilerLoweringFailureCode[] = [
      'duplicate-pass-name',
      'invalid-pass-order',
      'malformed-ir',
      'non-idempotent-pass',
      'pass-execution-failed',
    ];

    expect(
      codes.every((code) => isCompilerLoweringFailure(createCompilerLoweringFailure(code, 'pass', module, code))),
    ).toBe(true);
    expect(isCompilerLoweringFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerLoweringFailure(
        Object.assign(new Error('unknown'), {
          code: 'unknown',
          kind: 'compiler-lowering',
          packageName: module.packageName,
          pass: 'pass',
          source: module.source,
        }),
      ),
    ).toBe(false);
    expect(
      isCompilerLoweringFailure(
        Object.assign(new Error('missing pass'), {
          code: 'malformed-ir',
          kind: 'compiler-lowering',
          packageName: module.packageName,
          source: module.source,
        }),
      ),
    ).toBe(false);
  });
});

describe('lowerIrModuleWithCompilerPasses', () => {
  it('applies declared ordering deterministically without changing caller-owned input', () => {
    const first = createImportPass('first', 'first');
    const second = createImportPass('second', 'second', ['first']);
    const snapshot = structuredClone(module);

    const output = lowerIrModuleWithCompilerPasses(module, [first, second]);

    expect(output.imports.map((item) => item.specifier)).toEqual(['first', 'second']);
    expect(lowerIrModuleWithCompilerPasses(module, [first, second])).toEqual(output);
    expect(module).toEqual(snapshot);
    expect(output).not.toBe(module);
  });

  it('treats an empty plan as an identity while returning independent data', () => {
    const output = lowerIrModuleWithCompilerPasses(module, []);

    expect(output).toEqual(module);
    expect(output).not.toBe(module);
    expect(output.imports).not.toBe(module.imports);
  });

  it('allows a pass to declare that it is not idempotent', () => {
    const pass = createImportPass('non-idempotent', 'once', [], false);

    expect(lowerIrModuleWithCompilerPasses(module, [pass]).imports.map((item) => item.specifier)).toEqual(['once']);
  });

  it('rejects duplicate names, impossible order, malformed output, false idempotence, and thrown errors', () => {
    const first = createImportPass('first', 'first');
    const second = createImportPass('second', 'second', ['first']);
    expectFailure(() => lowerIrModuleWithCompilerPasses(module, [first, first]), 'duplicate-pass-name', 'first');
    expectFailure(() => lowerIrModuleWithCompilerPasses(module, [second, first]), 'invalid-pass-order', 'second');
    expectFailure(
      () => lowerIrModuleWithCompilerPasses(module, [createImportPass('self', 'self', ['self'])]),
      'invalid-pass-order',
      'self',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass(
            'malformed',
            (value) => structuredClone(value),
            () => ({ kind: 'invalid', reason: 'bad IR' }),
          ),
        ]),
      'malformed-ir',
      'malformed',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('claimed-idempotent', (value) => appendImport(value, 'again')),
        ]),
      'non-idempotent-pass',
      'claimed-idempotent',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('throws', () => {
            throw new Error('broken pass');
          }),
        ]),
      'pass-execution-failed',
      'throws',
    );
    expectFailure(
      () =>
        lowerIrModuleWithCompilerPasses(module, [
          createPass('throws-value', () => {
            const error: unknown = 'broken pass value';
            throw error;
          }),
        ]),
      'pass-execution-failed',
      'throws-value',
    );
  });
});

function appendImport(moduleValue: Readonly<IrModule>, specifier: string): IrModule {
  return { ...moduleValue, imports: [...moduleValue.imports, { bindings: [], specifier }] };
}

function createImportPass(
  name: string,
  specifier: string,
  runsAfter: readonly string[] = [],
  idempotent = true,
): CompilerLoweringPass {
  return createPass(
    name,
    (moduleValue) =>
      moduleValue.imports.some((item) => item.specifier === specifier)
        ? structuredClone(moduleValue)
        : appendImport(moduleValue, specifier),
    () => ({ kind: 'valid' }),
    runsAfter,
    idempotent,
  );
}

function createPass(
  name: string,
  lowerIrModule: CompilerLoweringPass['lowerIrModule'],
  verifyIrModule: CompilerLoweringPass['verifyIrModule'] = () => ({ kind: 'valid' }),
  runsAfter: readonly string[] = [],
  idempotent = true,
): CompilerLoweringPass {
  return { idempotent, lowerIrModule, name, runsAfter, verifyIrModule };
}

function expectFailure(run: () => unknown, code: CompilerLoweringFailureCode, pass: string): void {
  try {
    run();
    throw new Error('Expected compiler lowering failure');
  } catch (error) {
    expect(isCompilerLoweringFailure(error)).toBe(true);
    expect(error).toMatchObject({ code, kind: 'compiler-lowering', pass });
  }
}

const module: IrModule = {
  declarations: [],
  exports: [],
  imports: [],
  name: 'value',
  packageName: '@flighthq/math',
  source: 'src/value.ts',
};

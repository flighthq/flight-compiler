import { describe, expect, it } from 'vitest';

import { formatPublicApiReport } from './publicApiSurface.js';
import type { PublicApiExport } from './publicApiSurface.js';

const exports: readonly PublicApiExport[] = [
  { kind: 'type', name: 'IrModule' },
  { kind: 'function', name: 'compileIrModules' },
  { kind: 'value', name: 'compilerVersion' },
];

describe('formatPublicApiReport', () => {
  it('sorts exports by name regardless of input order', () => {
    const rows = formatPublicApiReport(exports)
      .split('\n')
      .filter((line) => line.startsWith('| `'));

    expect(rows).toEqual([
      '| `compileIrModules` | function |',
      '| `compilerVersion` | value |',
      '| `IrModule` | type |',
    ]);
  });

  it('counts each kind in the summary line', () => {
    expect(formatPublicApiReport(exports)).toContain('3 exports: 1 functions, 1 values, 1 types.');
  });

  it('is stable across calls with reordered input', () => {
    expect(formatPublicApiReport(exports)).toBe(formatPublicApiReport([...exports].reverse()));
  });

  it('does not mutate the caller’s array', () => {
    const input = [...exports];
    formatPublicApiReport(input);

    expect(input).toEqual(exports);
  });

  it('renders an empty surface without inventing rows', () => {
    const report = formatPublicApiReport([]);

    expect(report).toContain('0 exports: 0 functions, 0 values, 0 types.');
    expect(report.split('\n').filter((line) => line.startsWith('| `'))).toEqual([]);
  });

  it('ends with a single trailing newline so the committed file is stable', () => {
    expect(formatPublicApiReport(exports).endsWith('\n')).toBe(true);
    expect(formatPublicApiReport(exports).endsWith('\n\n')).toBe(false);
  });
});

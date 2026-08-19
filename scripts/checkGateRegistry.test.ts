import { describe, expect, it } from 'vitest';

import { createCheckGateRegistry } from './checkGateRegistry.js';

describe('createCheckGateRegistry', () => {
  it('records gates in registration order with their command and arguments', () => {
    const registry = createCheckGateRegistry();

    registry.add('lint', 'oxlint', ['--max-warnings=0']);
    registry.add('format:check', 'oxfmt', ['--check', '.']);

    expect(registry.gates).toEqual([
      { args: ['--max-warnings=0'], command: 'oxlint', label: 'lint' },
      { args: ['--check', '.'], command: 'oxfmt', label: 'format:check' },
    ]);
  });

  it('rejects a repeated stage name instead of running it twice', () => {
    const registry = createCheckGateRegistry();
    registry.add('docs:check', 'node', ['./.script-build/documentationHealth.js']);

    expect(() => registry.add('docs:check', 'node', ['./.script-build/documentationHealth.js'])).toThrow(
      "registers the gate 'docs:check' twice",
    );
    expect(registry.gates).toHaveLength(1);
  });

  it('rejects a repeated stage name even when the command differs', () => {
    const registry = createCheckGateRegistry();
    registry.add('typecheck', 'node', ['./.script-build/workspaceTypecheck.js']);

    expect(() => registry.add('typecheck', 'tsc', ['-p', 'tsconfig.json', '--noEmit'])).toThrow(
      "registers the gate 'typecheck' twice",
    );
  });

  it('keeps separate registries independent', () => {
    const first = createCheckGateRegistry();
    const second = createCheckGateRegistry();

    first.add('lint', 'oxlint', []);

    expect(() => second.add('lint', 'oxlint', [])).not.toThrow();
    expect(second.gates).toHaveLength(1);
  });

  it('starts empty so an unregistered sweep cannot report a vacuous pass', () => {
    expect(createCheckGateRegistry().gates).toEqual([]);
  });
});

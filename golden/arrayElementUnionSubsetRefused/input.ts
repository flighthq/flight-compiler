interface YamlSubsetValue {
  key: string;
}

interface ExtraValue {
  extra: number;
}

const marker = Symbol.for('marker');

function consume(_values: (YamlSubsetValue | ExtraValue | typeof marker)[]): number {
  return 1;
}

// The position holds an element union the value's array does not, and the target's container is parameterized
// by its element type: passing it would need a different container, and building one would copy the array and
// change the identity the source passes.
export function pass(values: (YamlSubsetValue | ExtraValue)[]): number {
  return consume(values);
}

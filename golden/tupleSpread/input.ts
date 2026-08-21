type Pair = [number, string];

function createPair(value: number, text: string): Pair {
  const pair: Pair = [value, text];
  return pair;
}

function createOptional(): [boolean?] {
  const value: [boolean?] = [];
  return value;
}

export function createTupleSpread(pair: Pair): [number, number, string, number, string, boolean?] {
  const value: [number, number, string, number, string, boolean?] = [
    0,
    ...pair,
    ...createPair(2, 'flight'),
    ...createOptional(),
  ];
  createPair(pair[0], pair[1]);
  return value;
}

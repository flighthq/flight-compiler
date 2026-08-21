type Pair = [number, string];

const pair: Pair = [1, 'flight'];

export const tupleSpread: [boolean, number, string, boolean?] = [true, ...pair];

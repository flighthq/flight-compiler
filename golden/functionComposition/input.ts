function double(x: number): number {
  return x * 2;
}

function addOne(x: number): number {
  return x + 1;
}

function square(x: number): number {
  return x * x;
}

export function doubleAndAdd(value: number): number {
  return addOne(double(value));
}

export function squareOfDouble(value: number): number {
  return square(double(value));
}

export function chainThree(value: number): number {
  return square(addOne(double(value)));
}

export function sumOfSquares(a: number, b: number): number {
  return square(a) + square(b);
}

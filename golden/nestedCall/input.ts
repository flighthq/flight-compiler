function double(x: number): number {
  return x * 2;
}

function addThree(x: number): number {
  return x + 3;
}

function square(x: number): number {
  return x * x;
}

export function applyTwice(x: number): number {
  return double(double(x));
}

export function composeResult(x: number): number {
  return addThree(double(x));
}

export function pipeFour(x: number): number {
  return square(addThree(double(x)));
}

export function nestedArithmetic(a: number, b: number): number {
  return double(a) + square(b) - addThree(a + b);
}

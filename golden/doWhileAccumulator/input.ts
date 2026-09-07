export function sumOneToN(n: number): number {
  let sum: number = 0;
  let i: number = 1;
  do {
    sum += i;
    i += 1;
  } while (i <= n);
  return sum;
}

export function repeatHalve(value: number): number {
  let result: number = value;
  let count: number = 0;
  do {
    result = Math.floor(result / 2);
    count += 1;
  } while (result > 0);
  return count;
}

export function reverseDigits(value: number): number {
  let n: number = Math.abs(value);
  let reversed: number = 0;
  do {
    reversed = reversed * 10 + (n % 10);
    n = Math.floor(n / 10);
  } while (n > 0);
  return value < 0 ? -reversed : reversed;
}

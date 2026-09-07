export function applyDiscount(prices: number[], factor: number): void {
  for (let i: number = 0; i < prices.length; i = i + 1) {
    prices[i] = prices[i]! * factor;
  }
}

export function clearArray(values: number[]): void {
  while (values.length > 0) {
    values.pop();
  }
}

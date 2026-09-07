export class Counter {
  #count: number = 0;

  public increment(): void {
    this.#count += 1;
  }

  public getCount(): number {
    return this.#count;
  }

  #reset(): void {
    this.#count = 0;
  }

  public clear(): void {
    this.#reset();
  }
}

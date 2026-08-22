export async function drain(task: Promise<number>, stop: boolean, skip: boolean): Promise<number> {
  let last: number = 0;
  while (true) {
    last = await task;
    if (skip) {
      continue;
    }
    if (stop) {
      break;
    }
  }
  return last;
}

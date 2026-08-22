export async function drain(task: Promise<number>, again: boolean): Promise<number> {
  let last: number = 0;
  let pending: boolean = true;
  while (pending) {
    last = await task;
    pending = again;
    again = false;
  }
  return last;
}

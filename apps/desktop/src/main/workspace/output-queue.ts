import { mkdir, realpath } from "node:fs/promises";
export class OutputQueue {
  #admissions: Promise<void> = Promise.resolve();
  #tails = new Map<string, Promise<void>>();
  run<T>(outputDir: string, work: () => Promise<T>): Promise<T> {
    let result!: Promise<T>;
    const admission = this.#admissions.then(async () => {
      await mkdir(outputDir, { recursive: true });
      const key = await realpath(outputDir);
      const previous = this.#tails.get(key) ?? Promise.resolve();
      result = previous.then(work);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      this.#tails.set(key, tail);
      void tail.then(() => {
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      });
    });
    this.#admissions = admission.catch(() => undefined);
    return admission.then(() => result);
  }
}

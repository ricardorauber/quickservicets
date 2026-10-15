import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Serializes work on a single database connection: while a transaction runs, operations started outside it wait,
 * and operations started inside it (detected through async context) run immediately.
 */
export class TransactionScope {
  private readonly context = new AsyncLocalStorage<true>();
  private tail: Promise<void> = Promise.resolve();

  inTransaction(): boolean {
    return this.context.getStore() === true;
  }

  /** Runs a standalone operation, waiting for any running transaction to finish first. */
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.inTransaction()) return operation();
    await this.tail;
    return operation();
  }

  /** Runs `fn` exclusively, using `begin`/`commit`/`rollback` around it. Nested calls join the outer transaction. */
  async transaction<T>(
    fn: () => Promise<T>,
    hooks: { begin(): void | Promise<void>; commit(): void | Promise<void>; rollback(): void | Promise<void> },
  ): Promise<T> {
    if (this.inTransaction()) return fn();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.context.run(true, async () => {
        await hooks.begin();
        try {
          const result = await fn();
          await hooks.commit();
          return result;
        } catch (error) {
          await hooks.rollback();
          throw error;
        }
      });
    } finally {
      release();
    }
  }
}

export class SerialExecutor {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const pending = this.tail.then(operation, operation);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

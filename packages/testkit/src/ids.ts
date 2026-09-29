import { AttemptId, EventId, type IdGenerator, TaskId, TraceId } from '@dvo/core';

/** Sequential, human-readable ids: `tsk_000001`, `att_000001`, … — stable across runs. */
export class SequentialIds implements IdGenerator {
  #n = 0;
  readonly #prefix: string;

  constructor(prefix = '') {
    this.#prefix = prefix;
  }

  #next(): string {
    this.#n += 1;
    return String(this.#n).padStart(6, '0');
  }

  taskId(): TaskId {
    return TaskId(`tsk_${this.#prefix}${this.#next()}`);
  }

  attemptId(): AttemptId {
    return AttemptId(`att_${this.#prefix}${this.#next()}`);
  }

  eventId(): EventId {
    return EventId(`evt_${this.#prefix}${this.#next()}`);
  }

  traceId(): TraceId {
    return TraceId(this.#next().padStart(32, 'a'));
  }

  spanId(): string {
    return this.#next().padStart(16, 'b');
  }
}

import type { EventRecord } from './types.js';

export interface IEventStore {
  insert(event: EventRecord): Promise<void>;
}

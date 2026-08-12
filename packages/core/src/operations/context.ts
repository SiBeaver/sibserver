import type { Sql } from '../storage/db.js';
import { NodeStore, EdgeStore, EventStore } from '../storage/stores.js';
import { GapStore } from '../storage/gap-store.js';
import { EventEmitter } from '../events/emitter.js';

// ============================================================
// 操作上下文 — 每个项目一个实例
// ============================================================

export class OperationContext {
  readonly nodes: NodeStore;
  readonly edges: EdgeStore;
  readonly events: EventEmitter;
  readonly eventStore: EventStore;
  readonly gap: GapStore;

  constructor(sql: Sql, projectId: string) {
    this.nodes = new NodeStore(sql, projectId);
    this.edges = new EdgeStore(sql, projectId);
    this.eventStore = new EventStore(sql, projectId);
    this.events = new EventEmitter(this.eventStore);
    this.gap = new GapStore(sql, projectId);
  }
}

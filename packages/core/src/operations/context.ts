import type { Sql } from '../storage/db.js';
import { NodeStore, EdgeStore, EventStore } from '../storage/stores.js';
import { GapStore } from '../storage/gap-store.js';
import { WorkpackStore } from '../storage/workpack-store.js';
import { ProposalStore } from '../storage/proposal-store.js';
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
  readonly workpacks: WorkpackStore;
  readonly proposals: ProposalStore;
  private readonly sql: Sql;
  private readonly projectId: string;

  constructor(sql: Sql, projectId: string) {
    this.sql = sql;
    this.projectId = projectId;
    this.nodes = new NodeStore(sql, projectId);
    this.edges = new EdgeStore(sql, projectId);
    this.eventStore = new EventStore(sql, projectId);
    this.events = new EventEmitter(this.eventStore);
    this.gap = new GapStore(sql, projectId);
    this.workpacks = new WorkpackStore(sql, projectId);
    this.proposals = new ProposalStore(sql, projectId);
  }

  /** 在单个数据库事务内执行操作；任一步失败整体回滚，不留孤儿行/部分状态 */
  async withTx<T>(fn: (ctx: OperationContext) => Promise<T>): Promise<T> {
    // postgres.js begin 返回 UnwrapPromiseArray<T>，对泛型 T 直接断言
    return this.sql.begin(async (tx) => fn(new OperationContext(tx as unknown as Sql, this.projectId))) as Promise<T>;
  }
}

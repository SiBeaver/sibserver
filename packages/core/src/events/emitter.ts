import { ulid } from 'ulidx';
import type { EventRecord, EventType, FieldDiff } from './types.js';
import type { IEventStore } from './interfaces.js';
import type { NodeType } from '../nodes/types.js';

// ============================================================
// 事件发射器 — 创建并持久化事件
// ============================================================

export class EventEmitter {
  constructor(private store: IEventStore) {}

  async emit(params: {
    event_type: EventType;
    operation: string;
    node_id?: string | null;
    node_type?: NodeType | null;
    payload?: Record<string, unknown>;
    diff?: FieldDiff[] | null;
    context?: string | null;
    actor?: 'user' | 'system';
  }): Promise<EventRecord> {
    const event: EventRecord = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      event_type: params.event_type,
      actor: params.actor ?? 'user',
      operation: params.operation,
      node_id: params.node_id ?? null,
      node_type: params.node_type ?? null,
      payload: params.payload ?? {},
      diff: params.diff ?? null,
      context: params.context ?? null,
    };

    await this.store.insert(event);
    return event;
  }

  // 便捷方法：计算两个对象之间的 diff
  static computeDiff(oldObj: Record<string, any>, newObj: Record<string, any>, fields: string[]): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    for (const field of fields) {
      const oldVal = oldObj[field];
      const newVal = newObj[field];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        diffs.push({ field, old_value: oldVal ?? null, new_value: newVal });
      }
    }
    return diffs;
  }
}

import type { EventRecord } from '@sibeaver/core';
import type { ApiEvent, ApiFieldDiff } from '../api-types.js';

/**
 * Key transformation utilities for API layer.
 * DB/operations use snake_case internally; REST API exposes camelCase.
 */

export function toApiEvent(ev: EventRecord): ApiEvent {
  return {
    id: ev.id,
    timestamp: ev.timestamp,
    eventType: ev.event_type,
    actor: ev.actor,
    operation: ev.operation,
    nodeId: ev.node_id,
    nodeType: ev.node_type,
    payload: ev.payload,
    diff: ev.diff as ApiFieldDiff[] | null,
    context: ev.context,
  };
}

function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}

export function snakeToCamel(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamelKey(key)] = snakeToCamel(value);
    }
    return result;
  }
  return obj;
}

export function camelToSnake(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(camelToSnake);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[camelToSnakeKey(key)] = camelToSnake(value);
    }
    return result;
  }
  return obj;
}

export function snakeToKebab(s: string): string {
  return s.replace(/_/g, '-');
}

export function kebabToSnake(s: string): string {
  return s.replace(/-/g, '_');
}

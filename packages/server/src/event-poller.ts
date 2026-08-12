import type { EventType } from '@sibeaver/core';
import { config } from './config/index.js';
import { sibs } from "./sibs-client.js";
import type { ApiEvent } from './api-types.js';

export type EventHandler = (event: ApiEvent) => Promise<void>;

const handlers = new Map<EventType, EventHandler[]>();
let lastSeen: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ============================================================
// Direct-mode: 统一部署时直接查询 eventStore，跳过 HTTP
// ============================================================

export interface DirectEventSource {
  getEvents(since?: string, limit?: number): Promise<{ events: ApiEvent[] }>;
}

let directEventSource: DirectEventSource | null = null;

export function setDirectEventSource(source: DirectEventSource): void {
  directEventSource = source;
}

export function onEvent(eventType: EventType, handler: EventHandler): void {
  const list = handlers.get(eventType) ?? [];
  list.push(handler);
  handlers.set(eventType, list);
}

async function poll() {
  try {
    let events: ApiEvent[];
    if (directEventSource) {
      const data = await directEventSource.getEvents(lastSeen ?? undefined);
      events = data.events ?? [];
    } else {
      const data = await sibs.getEvents(lastSeen ?? undefined);
      events = data.events ?? [];
    }
    if (events.length === 0) return;

    for (const event of events) {
      lastSeen = event.timestamp;
      const eventHandlers = handlers.get(event.eventType) ?? [];
      for (const handler of eventHandlers) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`[Poller] handler error for ${event.eventType}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[Poller] poll error:", err);
  }
}

export function startPoller(): void {
  if (timer) return;
  if (!config.sibsProject && !directEventSource) {
    console.warn("[Poller] SIBS_PROJECT not set, event polling disabled");
    return;
  }
  console.log(`[Poller] started, interval=${config.pollInterval}ms${directEventSource ? ' (direct mode)' : ''}`);
  timer = setInterval(poll, config.pollInterval);
  poll();
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

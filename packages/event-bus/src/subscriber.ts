import type { BusEvent, Channel } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('event-bus');

const DEFAULT_BUS_URL = 'http://localhost:3100';

export type EventHandler = (event: BusEvent) => void;

/**
 * Subscribe to one or more channels on the event bus via SSE.
 *
 * Automatically reconnects on connection drop (3 s back-off). The returned
 * dispose function stops reconnecting and aborts any in-flight request.
 *
 * @example
 * const dispose = subscribe('markets', (event) => {
 *   if (event.type === 'synced') handleSynced(event.data);
 * });
 * // later:
 * dispose();
 */
export function subscribe(
  channels: Channel | Channel[],
  handler: EventHandler,
  busUrl?: string,
): () => void {
  const url = busUrl ?? process.env.EVENT_BUS_URL ?? DEFAULT_BUS_URL;
  const channelList = Array.isArray(channels) ? channels : [channels];
  const channelsParam = channelList.join(',');

  let active = true;
  let currentAbort: AbortController | null = null;

  async function connect(): Promise<void> {
    while (active) {
      currentAbort = new AbortController();
      try {
        const res = await fetch(`${url}/events?channels=${channelsParam}`, {
          signal: currentAbort.signal,
          headers: { Accept: 'text/event-stream' },
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (active) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE blocks are separated by double newline
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const lines = block.split('\n');
            const dataLines = lines
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            try {
              const event = JSON.parse(dataLines.join('\n')) as BusEvent;
              handler(event);
            } catch {
              // Malformed event — skip silently
            }
          }
        }
      } catch {
        if (!active) break;
        // Back-off before reconnecting
        await new Promise<void>((r) => setTimeout(r, 3_000));
      }
    }
  }

  // Run connection loop in the background — intentionally not awaited
  connect().catch((err) => {
    if (active) log.error('subscriber connect loop crashed:', err);
  });

  return () => {
    active = false;
    currentAbort?.abort();
  };
}

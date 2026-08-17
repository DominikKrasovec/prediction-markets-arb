import type { PublishRequest } from '@arb/types';

const DEFAULT_BUS_URL = 'http://localhost:3100';

export async function publish(
  payload: PublishRequest,
  busUrl?: string,
): Promise<{ ok: boolean; delivered: number; eventId: string }> {
  const url = busUrl || process.env.EVENT_BUS_URL || DEFAULT_BUS_URL;
  const res = await fetch(`${url}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{ ok: boolean; delivered: number; eventId: string }>;
}

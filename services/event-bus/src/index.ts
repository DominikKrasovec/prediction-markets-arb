/**
 * Standalone Event Bus service — Express SSE fan-out on :3100
 *
 * Channels: markets | pipeline | arbitrage | prices
 *
 * Endpoints:
 *   GET  /events?channels=pipeline,markets  — SSE stream
 *   POST /publish                           — emit an event
 *   GET  /last-event?channel=X&type=Y       — retrieve latest event for (channel, type)
 *   GET  /health                            — liveness probe
 *
 * Start order: postgres → event-bus → ingestion → pipeline → arb-solver → dashboard
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import type { Request, Response } from 'express';
import type { BusEvent, Channel, PublishRequest } from '@arb/types';
import { CHANNELS } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('event-bus');

// ── Types ────────────────────────────────────────────────────────────────────

interface SSEClient {
  id: string;
  res: Response;
  channels: Set<Channel>;
  connectedAt: Date;
}

// ── State ────────────────────────────────────────────────────────────────────

const clients = new Map<string, SSEClient>();

/**
 * Stores the most recent event per (channel, type) key so poll-based consumers
 * (e.g. arb-solver graph-reload poller) can retrieve the last event without
 * maintaining a persistent SSE connection.
 */
const lastEventsByKey = new Map<string, BusEvent>();

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// SSE stream endpoint
app.get('/events', (req: Request, res: Response) => {
  const channelParam = (req.query.channels as string) || CHANNELS.join(',');
  const requestedChannels = new Set(
    channelParam.split(',').filter((c): c is Channel => CHANNELS.includes(c as Channel)),
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const clientId = uuid();
  clients.set(clientId, { id: clientId, res, channels: requestedChannels, connectedAt: new Date() });

  res.write(
    `id: ${uuid()}\nevent: connected\ndata: ${JSON.stringify({ clientId, channels: [...requestedChannels] })}\n\n`,
  );

  req.on('close', () => {
    clients.delete(clientId);
  });
});

// Publish endpoint
app.post('/publish', (req: Request, res: Response) => {
  const { channel, type, data } = req.body as PublishRequest;

  if (!channel || !type) {
    res.status(400).json({ error: 'channel and type are required' });
    return;
  }

  if (!CHANNELS.includes(channel)) {
    res.status(400).json({ error: `Invalid channel. Must be one of: ${CHANNELS.join(', ')}` });
    return;
  }

  const event: BusEvent = {
    id: uuid(),
    channel,
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  lastEventsByKey.set(`${channel}:${type}`, event);

  let delivered = 0;
  for (const client of clients.values()) {
    if (client.channels.has(channel)) {
      try {
        client.res.write(`id: ${event.id}\nevent: ${channel}:${type}\ndata: ${JSON.stringify(event)}\n\n`);
        delivered++;
      } catch {
        // Client socket closed between the 'close' event and this write —
        // remove it now so the next publish doesn't attempt it again.
        clients.delete(client.id);
      }
    }
  }

  res.json({ ok: true, delivered, eventId: event.id });
});

// Health endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    clients: clients.size,
    uptime: process.uptime(),
    channels: CHANNELS,
  });
});

// Last-event polling endpoint — used by arb-solver to detect graph_updated
app.get('/last-event', (req: Request, res: Response) => {
  const channel = req.query.channel as string;
  const type = req.query.type as string;
  if (!channel || !type) {
    res.status(400).json({ error: 'channel and type query params required' });
    return;
  }
  const event = lastEventsByKey.get(`${channel}:${type}`);
  if (!event) {
    res.status(404).json({ error: 'no event found' });
    return;
  }
  res.json(event);
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.EVENT_BUS_PORT ?? '3100', 10);

app.listen(PORT, () => {
  log.info(`Listening on :${PORT}`);
  log.info(`Channels: ${CHANNELS.join(', ')}`);
});

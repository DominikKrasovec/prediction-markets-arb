import 'dotenv/config';

export const config = {
  scrapeIntervalMs: parseInt(process.env.SCRAPE_INTERVAL_MS ?? '3600000'), // 1 hour
} as const;

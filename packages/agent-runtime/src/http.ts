import { createServer, type Server } from 'node:http';
import type { Logger } from '@apex/core';

/**
 * Minimal health endpoint. Cloud Run's container health checks hit /health to
 * decide whether an instance is ready for traffic and whether to restart it.
 * Deliberately dependency-free so a failing database cannot take the
 * container out of service when the right response is "degraded but alive".
 */
export function startHealthServer(
  port: number,
  log: Logger,
  probe: () => { healthy: boolean; detail: Record<string, unknown> },
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const { healthy, detail } = probe();
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', ...detail }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, () => log.info('health server listening', { port }));
  return server;
}

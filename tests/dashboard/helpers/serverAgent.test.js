import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { serverAgent } from './serverAgent.js';

describe('serverAgent', () => {
  it('listens once and serves sequential requests from the same port', async () => {
    const listenSpy = vi.spyOn(http.Server.prototype, 'listen');
    const app = express();
    app.get('/data', (req, res) => {
      res.json({ port: req.socket.localPort, value: 'ready' });
    });

    let close;
    try {
      const harness = await serverAgent(app);
      close = harness.close;

      const first = await harness.client.get('/data').expect(200);
      const second = await harness.client.get('/data').expect(200);

      expect(first.body).toEqual({ port: expect.any(Number), value: 'ready' });
      expect(second.body).toEqual(first.body);
      expect(listenSpy).toHaveBeenCalledTimes(1);
    } finally {
      await close?.();
      listenSpy.mockRestore();
    }
  });

  it('closes once across concurrent and sequential calls', async () => {
    const app = express();
    let server;
    app.get('/server', (req, res) => {
      server = req.socket.server;
      res.json({ ok: true });
    });

    let close;
    try {
      const harness = await serverAgent(app);
      close = harness.close;
      await harness.client.get('/server').expect(200, { ok: true });
      const closeSpy = vi.spyOn(server, 'close');

      const first = close();
      const second = close();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      await expect(close()).resolves.toBeUndefined();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(server.listening).toBe(false);
    } finally {
      await close?.();
    }
  });
});

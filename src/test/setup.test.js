// src/test/setup.test.js — the dom setup's own contract with MSW (src/test/setup.js): a request that no handler
// answers is refused. fetch rejects, MSW reports it as an error and nothing is sent, so a test can neither reach a real
// server nor pass on a handler it forgot. A local server stands in for the network, so "nothing is sent" is observed,
// not inferred, and the control shows that server answering once MSW does let a request through (passthrough()).
// MSW's own default for an unhandled request is to warn and send it on, which is what this file catches if the
// setup's option ever stops applying (a rename in a new MSW major, a typo).
import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw/http';
import { passthrough } from 'msw/utils/passthrough';
import { server } from './setup.js';

describe("the dom setup's MSW server", () => {
  /** What reached the local server, as `${method} ${path}`. */
  const received = [];
  let network;
  let origin;

  beforeAll(async () => {
    network = createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.end('from the network');
    });
    await new Promise((resolve) => { network.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${network.address().port}`;
  });
  beforeEach(() => { received.length = 0; });
  afterAll(() => new Promise((resolve) => { network.close(resolve); }));

  it('a request no handler answers is refused: fetch rejects, MSW reports an error and nothing is sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetch(`${origin}/unhandled`)).rejects.toThrow(); // what it rejects with is MSW's own choice
    expect(received).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`GET ${origin}/unhandled`));
    expect(warn).not.toHaveBeenCalled();
  });

  it('control: a handler answers instead of the network, and a request MSW lets through reaches the local server', async () => {
    server.use(
      http.get(`${origin}/handled`, () => HttpResponse.text('from MSW')),
      http.get(`${origin}/through`, () => passthrough()),
    );

    expect(await (await fetch(`${origin}/handled`)).text()).toBe('from MSW');
    expect(await (await fetch(`${origin}/through`)).text()).toBe('from the network');
    expect(received).toEqual(['GET /through']);
  });
});

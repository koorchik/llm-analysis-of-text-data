import { EmbeddingsBackendHttp } from './EmbeddingsBackendHttp';
import { createServer, type Server } from 'node:http';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';

interface Captured {
  body: unknown;
}

/**
 * A stand-in sidecar. Tests the wire contract — the shape `text-embeddings-inference` and a
 * `sentence-transformers` server both speak — without a Docker daemon or a model download.
 */
async function withServer(
  handler: (body: any) => { status?: number; payload: unknown },
  body: (url: string, captured: Captured) => Promise<void>
): Promise<void> {
  const captured: Captured = { body: undefined };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      captured.body = JSON.parse(Buffer.concat(chunks).toString());
      const { status = 200, payload } = handler(captured.body);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const vector = (seed: number) => [seed, seed + 1, seed + 2];

test('posts an OpenAI-shaped batch to /v1/embeddings and returns vectors in order', async () => {
  await withServer(
    (body) => ({
      payload: {
        data: body.input.map((_: string, index: number) => ({ index, embedding: vector(index) })),
        model: 'securebert',
        usage: { prompt_tokens: 12 },
      },
    }),
    async (url, captured) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      const response = await backend.embed(['APT28', 'Fancy Bear']);

      assert.deepEqual(captured.body, { input: ['APT28', 'Fancy Bear'], model: 'securebert' });
      assert.deepEqual(response.vectors, [vector(0), vector(1)]);
      assert.equal(response.dimensions, 3);
      assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 0 });
      assert.equal(response.model, 'securebert');
    }
  );
});

test('re-sorts by `index` when the sidecar answers out of order', async () => {
  await withServer(
    () => ({
      payload: {
        data: [
          { index: 1, embedding: vector(1) },
          { index: 0, embedding: vector(0) },
        ],
      },
    }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      const response = await backend.embed(['first', 'second']);
      assert.deepEqual(response.vectors, [vector(0), vector(1)]);
    }
  );
});

test('falls back to wire order when the sidecar omits `index`', async () => {
  await withServer(
    () => ({ payload: { data: [{ embedding: vector(0) }, { embedding: vector(1) }] } }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      const response = await backend.embed(['first', 'second']);
      assert.deepEqual(response.vectors, [vector(0), vector(1)]);
    }
  );
});

test('a short batch THROWS rather than silently mis-assigning vectors to surfaces', async () => {
  await withServer(
    () => ({ payload: { data: [{ index: 0, embedding: vector(0) }] } }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      await assert.rejects(() => backend.embed(['first', 'second']), /expected 2 vectors, got 1/);
    }
  );
});

test('a non-2xx response throws with the body attached, not a bare status', async () => {
  await withServer(
    () => ({ status: 422, payload: { error: 'input too long' } }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      await assert.rejects(() => backend.embed(['x']), /returned 422 .*input too long/s);
    }
  );
});

test('a response that is not OpenAI-shaped throws instead of yielding empty vectors', async () => {
  await withServer(
    () => ({ payload: { embeddings: [[1, 2, 3]] } }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url, model: 'securebert' });
      await assert.rejects(() => backend.embed(['x']), /not an OpenAI-shaped embeddings response/);
    }
  );
});

test('pooling and normalize are RECORDED in config — they change the numbers', async () => {
  const backend = new EmbeddingsBackendHttp({
    url: 'http://localhost:8080',
    model: 'securebert',
    pooling: 'mean',
    normalize: true,
  });
  assert.equal(backend.config.pooling, 'mean');
  assert.equal(backend.config.normalize, true);
  assert.equal(backend.provider, 'http');
});

test('a trailing slash on the base URL does not produce a double slash', async () => {
  await withServer(
    () => ({ payload: { data: [{ index: 0, embedding: vector(0) }] } }),
    async (url) => {
      const backend = new EmbeddingsBackendHttp({ url: `${url}///`, model: 'securebert' });
      const response = await backend.embed(['x']);
      assert.equal(response.vectors.length, 1);
    }
  );
});

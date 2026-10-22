import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadMediaStream, getMediaUrl } from './meta-api';

const fetchMock = vi.fn();
const url = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/test';
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  'http://lookaside.fbsbx.com/test',
  'https://lookaside.fbsbx.com.evil.test/test',
  'https://evil-fbcdn.net/test',
  'https://127.0.0.1/test',
  'https://example.test/test',
  'https://user:password@lookaside.fbsbx.com/test',
  'https://lookaside.fbsbx.com:8443/test',
  'file:///private/test',
])(
  'rejects untrusted download URL %s before sending authorization',
  async (downloadUrl) => {
    fetchMock.mockResolvedValue(new Response('bytes'));
    await expect(
      downloadMediaStream({ downloadUrl, accessToken: 'dummy-token' })
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).not.toHaveBeenCalled();
  }
);
it('never follows download redirects or sends browser credentials', async () => {
  fetchMock.mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: 'https://evil.test/steal' },
    })
  );
  await expect(
    downloadMediaStream({ downloadUrl: url, accessToken: 'dummy-token' })
  ).rejects.toMatchObject({ status: 502 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  });
});

it.each(['metadata', 'download'])(
  'bounds %s fetch with a 15 second abort deadline',
  async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal!.reason), {
          once: true,
        })
      );
    });
    const pending =
      stage === 'metadata'
        ? getMediaUrl({ mediaId: '12345', accessToken: 'dummy-token' })
        : downloadMediaStream({ downloadUrl: url, accessToken: 'dummy-token' });
    // Assert the signal before awaiting, so old unbounded implementations fail fast.
    expect(signal).toBeInstanceOf(AbortSignal);
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
);
it('keeps the deadline active while the body stalls and cancels it on timeout', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  fetchMock.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'image/png' },
    })
  );
  const result = await downloadMediaStream({
    downloadUrl: url,
    accessToken: 'dummy-token',
  });
  expect(vi.getTimerCount()).toBe(1);
  const rejected = expect(
    new Response(result.body).arrayBuffer()
  ).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15001);
  await rejected;
  expect(cancel).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels upstream and clears timers when the consumer cancels', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
  const result = await downloadMediaStream({
    downloadUrl: url,
    accessToken: 'dummy-token',
  });
  expect(vi.getTimerCount()).toBe(1);
  await result.body.cancel();
  expect(cancel).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('redacts errors raised after streaming has started', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  fetchMock.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      })
    )
  );
  const result = await downloadMediaStream({
    downloadUrl: url,
    accessToken: 'dummy-token',
  });
  controller.error(new Error('SECRET signed URL/token'));
  await expect(new Response(result.body).arrayBuffer()).rejects.toMatchObject({
    status: 502,
    message: 'WhatsApp media service unavailable',
  });
});
it('never follows metadata redirects or uses a cache', async () => {
  fetchMock.mockResolvedValue(Response.json({ url, mime_type: 'image/jpeg' }));
  await getMediaUrl({ mediaId: '12345', accessToken: 'dummy-token' });
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  });
});

it('falls back to octet-stream for malformed MIME metadata instead of crashing', async () => {
  fetchMock.mockResolvedValue(
    new Response(new Uint8Array([0, 255]), {
      headers: { 'content-type': 'application/octet-stream' },
    })
  );
  const result = await downloadMediaStream({
    downloadUrl: url,
    accessToken: 'dummy-token',
    mimeType: 17 as unknown as string,
  });
  expect(result.contentType).toBe('application/octet-stream');
  await result.body.cancel();
});

it('downloads binary as a stream without arrayBuffer and uses metadata for generic MIME', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const upstream = new Response(bytes, {
    headers: { 'content-type': 'application/octet-stream' },
  });
  const bufferSpy = vi.spyOn(upstream, 'arrayBuffer');
  fetchMock.mockResolvedValue(upstream);
  const result = await downloadMediaStream({
    downloadUrl: url,
    accessToken: 'dummy-token',
    mimeType: 'image/png',
  });
  expect(result.contentType).toBe('image/png');
  expect(result.body).toBeInstanceOf(ReadableStream);
  expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(
    bytes
  );
  expect(bufferSpy).not.toHaveBeenCalled();
});

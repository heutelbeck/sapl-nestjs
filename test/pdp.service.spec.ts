import { PdpService } from '../lib/pdp.service';
import { SAPL_MODULE_OPTIONS } from '../lib/sapl.constants';

function createService(overrides: Record<string, any> = {}): PdpService {
  return new PdpService({
    baseUrl: 'https://localhost:8443',
    timeout: 5000,
    streamingMaxRetries: 0,
    ...overrides,
  });
}

function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchResponse(body: ReadableStream, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    body,
    text: () => Promise.resolve(''),
    headers: new Headers(),
  } as any;
}

/** Filter out trailing INDETERMINATE emitted on stream-end */
function decisions(emissions: any[]): any[] {
  const last = emissions[emissions.length - 1];
  if (last?.decision === 'INDETERMINATE') {
    return emissions.slice(0, -1);
  }
  return emissions;
}

describe('PdpService', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    test('whenBaseUrlIsHttpWithoutFlagThenThrows', () => {
      expect(() => createService({ baseUrl: 'http://localhost:8443' })).toThrow(
        'Use HTTPS or set allowInsecureConnections: true',
      );
    });

    test('whenBaseUrlIsHttpWithAllowInsecureThenCreatesService', () => {
      const service = createService({
        baseUrl: 'http://localhost:8443',
        allowInsecureConnections: true,
      });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenBaseUrlIsHttpsThenCreatesServiceNormally', () => {
      const service = createService({ baseUrl: 'https://localhost:8443' });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenBaseUrlIsInvalidThenThrows', () => {
      expect(() => createService({ baseUrl: 'not-a-url' })).toThrow();
    });
  });

  describe('decideOnce', () => {
    test('whenPdpReturnsPermitThenResolvesWithPermitDecision', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'PERMIT' });
    });

    test('whenPdpReturnsNon200ThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('error body'),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpUnreachableThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenTimeoutExceededThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockImplementation(() =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 100)),
      );

      const service = createService({ timeout: 50 });
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenTokenConfiguredThenAuthorizationHeaderSent', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService({ token: 'my-token' });
      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer my-token');
    });

    test('whenResponseBodyMalformedThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpReturnsNonObjectThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve('just a string'),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpReturnsMissingDecisionFieldThenResolvesWithIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpReturnsUnknownFieldsThenDropsExtras', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT', message: 'hi', debug: {} }),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'PERMIT' });
    });

    test('whenPdpReturnsObligationsThenPreserved', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT', obligations: [{ type: 'log' }] }),
      });

      const service = createService();
      const result = await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(result).toEqual({ decision: 'PERMIT', obligations: [{ type: 'log' }] });
    });
  });

  describe('decide', () => {
    test('whenPdpStreamsMultipleDecisionsThenObservableEmitsAll', (done) => {
      const stream = createReadableStream([
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([
            { decision: 'PERMIT' },
            { decision: 'DENY' },
            { decision: 'PERMIT' },
          ]);
          done();
        },
      });
    });

    test('whenPdpStreamEndsThenEmitsIndeterminateAndErrors', (done) => {
      const stream = createReadableStream([
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (err) => {
          expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
          expect(err.message).toBe('PDP decision stream ended unexpectedly');
          done();
        },
      });
    });

    test('whenPdpConnectionFailsThenObservableEmitsIndeterminateAndErrors', (done) => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(emissions).toEqual([{ decision: 'INDETERMINATE' }]);
          done();
        },
      });
    });

    test('whenUnsubscribedThenFetchAborted', (done) => {
      let abortSignal: AbortSignal | undefined;
      globalThis.fetch = jest.fn().mockImplementation((_url: string, init: any) => {
        abortSignal = init.signal;
        return new Promise(() => {});
      });

      const service = createService();
      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe();

      setTimeout(() => {
        sub.unsubscribe();
        expect(abortSignal?.aborted).toBe(true);
        done();
      }, 50);
    });

    test('whenSSEChunkSplitsAcrossDataLinesThenParsesCorrectly', (done) => {
      const stream = createReadableStream([
        'data: {"deci',
        'sion":"PERMIT"}\n\ndata: {"decision":"DENY"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([
            { decision: 'PERMIT' },
            { decision: 'DENY' },
          ]);
          done();
        },
      });
    });

    test('whenSSEContainsCommentLinesThenIgnored', (done) => {
      const stream = createReadableStream([
        ': this is a comment\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([{ decision: 'PERMIT' }]);
          done();
        },
      });
    });

    test('whenSSEContainsEmptyDataThenSkipped', (done) => {
      const stream = createReadableStream([
        'data: \n\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([{ decision: 'PERMIT' }]);
          done();
        },
      });
    });

    test('whenStreamingResponseHasNullBodyThenEmitsIndeterminateAndErrors', (done) => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        headers: new Headers(),
      });

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (err) => {
          expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
          expect(err.message).toBe('PDP streaming response has no body');
          done();
        },
      });
    });

    test('whenPdpReturnsNon200OnStreamThenObservableEmitsIndeterminate', (done) => {
      const stream = createReadableStream([]);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: stream,
        text: () => Promise.resolve('error body'),
        headers: new Headers(),
      });

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(emissions).toEqual([{ decision: 'INDETERMINATE' }]);
          done();
        },
      });
    });

    test('whenTokenConfiguredThenAuthorizationHeaderSent', (done) => {
      const stream = createReadableStream(['data: {"decision":"PERMIT"}\n\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService({ token: 'my-token' });

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        error: () => {
          const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
          expect(init.headers['Authorization']).toBe('Bearer my-token');
          expect(init.headers['Accept']).toBe('application/x-ndjson');
          done();
        },
      });
    });

    test('whenStreamContainsInvalidDecisionThenEmitsIndeterminate', (done) => {
      const stream = createReadableStream([
        '{"bad":"data"}\n',
        '{"decision":"PERMIT"}\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([
            { decision: 'INDETERMINATE' },
            { decision: 'PERMIT' },
          ]);
          done();
        },
      });
    });

    test('whenStreamingBufferExceedsLimitThenEmitsIndeterminateAndErrors', (done) => {
      // Create a stream that sends >1MB with no newlines
      const largeChunk = 'x'.repeat(1_100_000);
      const stream = createReadableStream([largeChunk]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (err) => {
          expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
          expect(err.message).toBe('PDP streaming buffer overflow');
          done();
        },
      });
    });

    test('whenPdpStreamsRepeatedDecisionsThenDuplicatesSuppressed', (done) => {
      const stream = createReadableStream([
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService();
      const emissions: any[] = [];

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => {
          expect(decisions(emissions)).toEqual([
            { decision: 'PERMIT' },
            { decision: 'DENY' },
            { decision: 'PERMIT' },
          ]);
          done();
        },
      });
    });
  });

  describe('decide retry', () => {
    let randomSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1.0);
    });

    afterEach(() => {
      randomSpy.mockRestore();
      jest.useRealTimers();
    });

    test('whenConnectionFailsThenRetriesAndRecovers', async () => {
      let fetchCallCount = 0;

      globalThis.fetch = jest.fn().mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return Promise.reject(new Error('Connection refused'));
        }
        const stream = createReadableStream(['data: {"decision":"PERMIT"}\n\n']);
        return Promise.resolve(mockFetchResponse(stream));
      });

      const service = createService({
        streamingMaxRetries: 3,
        streamingRetryBaseDelay: 1000,
        streamingRetryMaxDelay: 5000,
      });
      const emissions: any[] = [];
      let errorSeen = false;

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => { errorSeen = true; },
      });

      // Flush: first fetch rejects -> INDETERMINATE emitted -> retry delay starts
      await jest.advanceTimersByTimeAsync(0);
      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });

      // Advance past retry delay (1000ms) -> second fetch succeeds
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(2);
      expect(emissions).toContainEqual({ decision: 'PERMIT' });
    });

    test('whenStreamDisconnectsThenReconnectsAndResumesDecisions', async () => {
      let fetchCallCount = 0;

      globalThis.fetch = jest.fn().mockImplementation(() => {
        fetchCallCount++;
        const stream = createReadableStream([
          `data: {"decision":"PERMIT","attempt":${fetchCallCount}}\n\n`,
        ]);
        return Promise.resolve(mockFetchResponse(stream));
      });

      const service = createService({
        streamingMaxRetries: 2,
        streamingRetryBaseDelay: 100,
        streamingRetryMaxDelay: 500,
      });
      const emissions: any[] = [];
      let finalError: Error | null = null;

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (e) => { finalError = e; },
      });

      // Attempt 1: stream opens, PERMIT emitted, stream ends -> INDETERMINATE -> retry
      await jest.advanceTimersByTimeAsync(0);
      // Retry 1 delay: 100ms
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(0);
      // Retry 2 delay: 200ms
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(0);
      // Max retries exceeded
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(3);
      const permits = emissions.filter((e) => e.decision === 'PERMIT');
      expect(permits.length).toBe(3);
      expect(finalError).not.toBeNull();
    });

    test('whenMaxRetriesExceededThenErrorPropagates', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService({
        streamingMaxRetries: 2,
        streamingRetryBaseDelay: 100,
        streamingRetryMaxDelay: 500,
      });
      let finalError: Error | null = null;

      service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        error: (err) => { finalError = err; },
      });

      // Attempt 1 fails
      await jest.advanceTimersByTimeAsync(0);
      // Retry 1 delay: 100ms
      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(0);
      // Retry 2 delay: 200ms
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(0);

      // 1 initial + 2 retries = 3 total fetch calls
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(finalError).toBeInstanceOf(Error);
    });

    test('whenUnsubscribedDuringRetryDelayThenCleansUp', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService({
        streamingMaxRetries: Infinity,
        streamingRetryBaseDelay: 60000,
      });

      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        error: () => {},
      });

      // First attempt fails -> retry delay starts (60s)
      await jest.advanceTimersByTimeAsync(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // Unsubscribe during the long retry delay
      sub.unsubscribe();

      // Advance well past the delay -- no new fetch should happen
      await jest.advanceTimersByTimeAsync(120000);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

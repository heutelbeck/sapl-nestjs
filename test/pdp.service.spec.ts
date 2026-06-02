import { PdpService } from '../lib/pdp.service';
import { OAuth2TokenProvider } from '../lib/transport/auth/OAuth2TokenProvider';

const OAUTH2_OPTIONS = {
  issuerUrl: 'https://issuer.example/realms/sapl',
  clientId: 'sapl-client',
  clientSecret: 'secret',
};

function createService(overrides: Record<string, any> = {}): PdpService {
  return new PdpService({
    baseUrl: 'https://localhost:8443',
    timeout: 5000,
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

/**
 * The streaming subscription never terminates: on stream-end or transport
 * failure it emits INDETERMINATE and reconnects with backoff forever. To
 * observe a single connection's emissions deterministically, callers configure
 * a large `streamingRetryBaseDelay` (so no reconnect fires inside the window),
 * subscribe, and wait for a quiet period after the last emission before
 * unsubscribing. The subscription never errors or completes on its own; a
 * terminal error or completion here is a contract violation and fails the test.
 */
function collectFirstConnectionEmissions(
  observable: import('rxjs').Observable<any>,
  quietMs = 50,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const emissions: any[] = [];
    let quietTimer: NodeJS.Timeout;
    const sub = observable.subscribe({
      next: (decision) => {
        emissions.push(decision);
        clearTimeout(quietTimer);
        quietTimer = setTimeout(settle, quietMs);
      },
      error: (error) => {
        clearTimeout(quietTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      complete: () => {
        clearTimeout(quietTimer);
        reject(new Error('streaming subscription completed; the contract forbids self-termination'));
      },
    });
    function settle(): void {
      sub.unsubscribe();
      resolve(emissions);
    }
    quietTimer = setTimeout(settle, quietMs);
  });
}

const LONG_RETRY = { streamingRetryBaseDelay: 60000, streamingRetryMaxDelay: 60000 };

describe('PdpService', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    test('whenBaseUrlIsHttpAndNonLoopbackThenThrows', () => {
      expect(() => createService({ baseUrl: 'http://example.com:8443' })).toThrow(
        'plain HTTP and targets a non-loopback host',
      );
    });

    test('whenBaseUrlIsHttpAndLoopbackThenCreatesServiceWithWarning', () => {
      const service = createService({ baseUrl: 'http://localhost:8443' });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenBaseUrlIsHttpAndLoopbackIpv4ThenCreatesService', () => {
      const service = createService({ baseUrl: 'http://127.0.0.1:8443' });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenBaseUrlIsHttpsThenCreatesServiceNormally', () => {
      const service = createService({ baseUrl: 'https://localhost:8443' });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenBaseUrlIsInvalidThenThrows', () => {
      expect(() => createService({ baseUrl: 'not-a-url' })).toThrow();
    });

    test('whenBothTokenAndBasicAuthConfiguredThenThrows', () => {
      expect(() => createService({ token: 'my-token', username: 'user', secret: 'pass' })).toThrow(
        'authentication conflict',
      );
    });

    test('whenBothOauth2AndTokenConfiguredThenThrows', () => {
      expect(() => createService({ token: 'my-token', oauth2: OAUTH2_OPTIONS })).toThrow(
        'authentication conflict',
      );
    });

    test('whenRsocketTransportNonLoopbackWithoutTlsThenThrows', () => {
      expect(() =>
        createService({
          transport: 'rsocket',
          baseUrl: 'https://pdp.example.com:8443',
          rsocketHost: 'pdp.example.com',
        }),
      ).toThrow('refuses to connect plaintext');
    });

    test('whenRsocketTransportNonLoopbackWithTlsThenCreatesService', () => {
      const service = createService({
        transport: 'rsocket',
        baseUrl: 'https://pdp.example.com:8443',
        rsocketHost: 'pdp.example.com',
        tls: { rejectUnauthorized: false },
      });
      expect(service).toBeInstanceOf(PdpService);
    });

    test('whenRsocketTransportWithOauth2ThenCreatesService', () => {
      const service = createService({
        transport: 'rsocket',
        baseUrl: 'https://localhost:8443',
        oauth2: OAUTH2_OPTIONS,
      });
      expect(service).toBeInstanceOf(PdpService);
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
      globalThis.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            const err = new DOMException('The operation was aborted', 'AbortError');
            setTimeout(() => reject(err), 100);
          }),
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

    test('whenOauth2ConfiguredThenAuthorizationHeaderUsesProviderToken', async () => {
      const getAccessToken = jest
        .spyOn(OAuth2TokenProvider.prototype, 'getAccessToken')
        .mockResolvedValue('minted-jwt');
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService({ oauth2: OAUTH2_OPTIONS });
      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer minted-jwt');
      expect(getAccessToken).toHaveBeenCalled();
      getAccessToken.mockRestore();
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

    test('whenBasicAuthConfiguredThenBasicHeaderSent', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService({ username: 'admin', secret: 's3cret' });
      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      const expected = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`;
      expect(init.headers['Authorization']).toBe(expected);
    });

    test('whenSubscriptionHasSecretsThenSecretsNotInLogs', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService();
      const logSpy = jest.spyOn((service as any).client.logger, 'debug');

      await service.decideOnce({
        subject: 'user',
        action: 'read',
        resource: 'data',
        secrets: { apiKey: 'super-secret-key-12345' },
      } as any);

      const allLogs = logSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(allLogs).not.toContain('super-secret-key-12345');
      logSpy.mockRestore();
    });

    test('whenAuthConfiguredThenCredentialsNotInLogs', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ decision: 'PERMIT' }),
      });

      const service = createService({ token: 'sensitive-bearer-token' });
      const debugSpy = jest.spyOn((service as any).client.logger, 'debug');
      const logSpy = jest.spyOn((service as any).client.logger, 'log');

      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      const allLogs = [...debugSpy.mock.calls, ...logSpy.mock.calls].map((c) => c[0]).join(' ');
      expect(allLogs).not.toContain('sensitive-bearer-token');
      debugSpy.mockRestore();
      logSpy.mockRestore();
    });

    test('whenPdpReturnsErrorThenResponseBodyTruncatedInLog', async () => {
      const longBody = 'x'.repeat(1000);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(longBody),
      });

      const service = createService();
      const errorSpy = jest.spyOn((service as any).client.logger, 'error');

      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      const loggedBody = errorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(loggedBody).not.toContain(longBody);
      expect(loggedBody).toContain('...');
      errorSpy.mockRestore();
    });

    test('whenRequestResponseFailsThenNoRetry', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService();
      await service.decideOnce({ subject: 'user', action: 'read', resource: 'data' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('decide', () => {
    test('whenPdpStreamsMultipleDecisionsThenObservableEmitsAll', async () => {
      const stream = createReadableStream([
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([
        { decision: 'PERMIT' },
        { decision: 'DENY' },
        { decision: 'PERMIT' },
      ]);
    });

    test('whenPdpStreamEndsThenEmitsIndeterminate', async () => {
      const stream = createReadableStream(['data: {"decision":"PERMIT"}\n\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpConnectionFailsThenObservableEmitsIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(emissions).toEqual([{ decision: 'INDETERMINATE' }]);
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

    test('whenSSEChunkSplitsAcrossDataLinesThenParsesCorrectly', async () => {
      const stream = createReadableStream([
        'data: {"deci',
        'sion":"PERMIT"}\n\ndata: {"decision":"DENY"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([{ decision: 'PERMIT' }, { decision: 'DENY' }]);
    });

    test('whenSSEContainsCommentLinesThenIgnored', async () => {
      const stream = createReadableStream([': this is a comment\n', 'data: {"decision":"PERMIT"}\n\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([{ decision: 'PERMIT' }]);
    });

    test('whenSSEContainsEmptyDataThenSkipped', async () => {
      const stream = createReadableStream(['data: \n\n', 'data: {"decision":"PERMIT"}\n\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([{ decision: 'PERMIT' }]);
    });

    test('whenStreamingResponseHasNullBodyThenEmitsIndeterminate', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        headers: new Headers(),
      });

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpReturnsNon200OnStreamThenObservableEmitsIndeterminate', async () => {
      const stream = createReadableStream([]);
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: stream,
        text: () => Promise.resolve('error body'),
        headers: new Headers(),
      });

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(emissions).toEqual([{ decision: 'INDETERMINATE' }]);
    });

    test('whenTokenConfiguredThenAuthorizationHeaderSent', async () => {
      const stream = createReadableStream(['data: {"decision":"PERMIT"}\n\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService({ token: 'my-token', ...LONG_RETRY });
      await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer my-token');
      expect(init.headers['Accept']).toBe('text/event-stream');
    });

    test('whenStreamContainsInvalidDecisionThenEmitsIndeterminate', async () => {
      const stream = createReadableStream(['{"bad":"data"}\n', '{"decision":"PERMIT"}\n']);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([{ decision: 'INDETERMINATE' }, { decision: 'PERMIT' }]);
    });

    test('whenStreamingBufferExceedsLimitThenEmitsIndeterminate', async () => {
      // Create a stream that sends >1MB with no newlines
      const largeChunk = 'x'.repeat(1_100_000);
      const stream = createReadableStream([largeChunk]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
    });

    test('whenPdpStreamsRepeatedDecisionsThenDuplicatesSuppressed', async () => {
      const stream = createReadableStream([
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"DENY"}\n\n',
        'data: {"decision":"PERMIT"}\n\n',
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([
        { decision: 'PERMIT' },
        { decision: 'DENY' },
        { decision: 'PERMIT' },
      ]);
    });

    test('whenMultiByteUtf8SplitAcrossChunksThenParsesCorrectly', async () => {
      const encoder = new TextEncoder();
      const fullLine = 'data: {"decision":"PERMIT","resource":"\u00fc\u00e4\u00f6"}\n\n';
      const bytes = encoder.encode(fullLine);
      const splitPoint = Math.floor(bytes.length / 2);
      const chunk1 = bytes.slice(0, splitPoint);
      const chunk2 = bytes.slice(splitPoint);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions)).toEqual([{ decision: 'PERMIT', resource: '\u00fc\u00e4\u00f6' }]);
    });

    test('whenDeeplyNestedDecisionsThenTreatedAsDifferent', async () => {
      function buildNested(leaf: string, depth: number): any {
        let obj: any = leaf;
        for (let i = 0; i < depth; i++) {
          obj = { [`level${i}`]: obj };
        }
        return obj;
      }
      const deep1 = buildNested('value1', 21);
      const deep2 = buildNested('value2', 21);
      const decision1 = { decision: 'PERMIT', obligations: [deep1] };
      const decision2 = { decision: 'PERMIT', obligations: [deep2] };
      const stream = createReadableStream([
        `data: ${JSON.stringify(decision1)}\n\n`,
        `data: ${JSON.stringify(decision2)}\n\n`,
      ]);
      globalThis.fetch = jest.fn().mockResolvedValue(mockFetchResponse(stream));

      const service = createService(LONG_RETRY);
      const emissions = await collectFirstConnectionEmissions(
        service.decide({ subject: 'user', action: 'read', resource: 'data' }),
      );

      expect(decisions(emissions).length).toBe(2);
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
        streamingRetryBaseDelay: 1000,
        streamingRetryMaxDelay: 5000,
      });
      const emissions: any[] = [];

      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: () => undefined,
      });

      // Flush: first fetch rejects -> INDETERMINATE emitted -> retry delay starts
      await jest.advanceTimersByTimeAsync(0);
      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });

      // Advance past retry delay (1000ms) -> second fetch succeeds
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(2);
      expect(emissions).toContainEqual({ decision: 'PERMIT' });

      sub.unsubscribe();
    });

    test('whenStreamRepeatedlyEndsThenReconnectsForeverWithoutTerminating', async () => {
      let fetchCallCount = 0;

      globalThis.fetch = jest.fn().mockImplementation(() => {
        fetchCallCount++;
        const stream = createReadableStream([`data: {"decision":"PERMIT","attempt":${fetchCallCount}}\n\n`]);
        return Promise.resolve(mockFetchResponse(stream));
      });

      const service = createService({
        streamingRetryBaseDelay: 100,
        streamingRetryMaxDelay: 500,
      });
      const emissions: any[] = [];
      let terminalError: Error | null = null;
      let completed = false;

      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (e) => {
          terminalError = e;
        },
        complete: () => {
          completed = true;
        },
      });

      // Each attempt opens, emits PERMIT, ends -> INDETERMINATE -> reconnect.
      // Drive many reconnect cycles; the subscription must keep going.
      for (let i = 0; i < 5; i++) {
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(500);
      }
      await jest.advanceTimersByTimeAsync(0);

      // It reconnected far beyond any finite bound and never terminated.
      expect(fetchCallCount).toBeGreaterThanOrEqual(5);
      const permits = emissions.filter((e) => e.decision === 'PERMIT');
      expect(permits.length).toBeGreaterThanOrEqual(5);
      expect(terminalError).toBeNull();
      expect(completed).toBe(false);

      sub.unsubscribe();
    });

    test('whenConnectionFailsRepeatedlyThenEmitsIndeterminateAndNeverErrors', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService({
        streamingRetryBaseDelay: 100,
        streamingRetryMaxDelay: 500,
      });
      const emissions: any[] = [];
      let terminalError: Error | null = null;
      let completed = false;

      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        next: (d) => emissions.push(d),
        error: (err) => {
          terminalError = err;
        },
        complete: () => {
          completed = true;
        },
      });

      // Drive far more cycles than any old finite retry budget. The
      // subscription keeps reconnecting and emitting INDETERMINATE; it
      // never propagates a terminal error or completes.
      for (let i = 0; i < 6; i++) {
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(0);
      }

      expect((globalThis.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(6);
      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });
      expect(terminalError).toBeNull();
      expect(completed).toBe(false);

      sub.unsubscribe();
    });

    test('whenUnsubscribedDuringRetryDelayThenCleansUp', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const service = createService({
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

    test('whenAuthErrorOnStreamThenLoggedAtErrorEveryTime', async () => {
      let fetchCallCount = 0;
      globalThis.fetch = jest.fn().mockImplementation(() => {
        fetchCallCount++;
        const stream = createReadableStream([]);
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          body: stream,
          text: () => Promise.resolve('Unauthorized'),
          headers: new Headers(),
        });
      });

      const service = createService({
        streamingRetryBaseDelay: 100,
        streamingRetryMaxDelay: 500,
      });
      const errorSpy = jest.spyOn((service as any).client.logger, 'error');

      const sub = service.decide({ subject: 'user', action: 'read', resource: 'data' }).subscribe({
        error: () => {},
      });

      // Drive several reconnect cycles. The subscription never terminates,
      // so every failed attempt logs the auth failure at error level.
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(0);
      }
      await jest.advanceTimersByTimeAsync(0);

      const authMessages = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('authentication failed'));

      expect(authMessages.length).toBe(fetchCallCount);

      errorSpy.mockRestore();
      sub.unsubscribe();
    });
  });
});

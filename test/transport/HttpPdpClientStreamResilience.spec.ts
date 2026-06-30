import { Logger } from '@nestjs/common';
import { HttpPdpClient } from '../../lib/transport/HttpPdpClient';
import type { AuthorizationDecision } from '../../lib/types';

/**
 * Operational resilience contract for the HTTP SSE transport, mirroring the
 * Spring reference PEP. Covers:
 *  - CR-11/AP-11: first-decision + per-item inactivity liveness timeouts on the
 *    open stream so a silent half-open connection fails closed and reconnects.
 *  - CR-08/AP-13: the reconnect backoff / log-escalation counter resets on every
 *    successful decision, so a brief outage after a healthy period restarts at
 *    attempt one (WARN, base delay) rather than the lifetime-accumulated count.
 */

const SUBSCRIPTION = { subject: 'alice', action: 'read', resource: 'doc-1' };

const encoder = new TextEncoder();

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

function sseResponse(frames: string[], options: { keepOpen?: boolean } = {}): FetchResponse {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      if (!options.keepOpen) {
        controller.close();
      }
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
    text: async () => '',
    json: async () => ({}),
  };
}

const permitFrame = `data: ${JSON.stringify({ decision: 'PERMIT' })}\n\n`;

describe('HttpPdpClient streaming resilience contract', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function newClient(): HttpPdpClient {
    // HTTPS avoids the loopback plaintext warning so logger spies only capture
    // reconnect-related output. The fetch global is stubbed, so no TLS is used.
    return new HttpPdpClient({
      baseUrl: 'https://localhost:8443',
      streamingRetryBaseDelay: 5,
      streamingRetryMaxDelay: 5,
    });
  }

  describe('liveness timeout on a silent open connection (CR-11)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test('whenConnectionDeliversNoFirstDecisionThenIndeterminateAndReconnect', async () => {
      const fetchMock = jest.fn().mockResolvedValue(sseResponse([], { keepOpen: true }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const emissions: AuthorizationDecision[] = [];
      const sub = newClient()
        .decide(SUBSCRIPTION)
        .subscribe({ next: (decision) => emissions.push(decision) });

      // Headers arrive, then the server holds the socket open and sends nothing.
      // Drive the exact boundaries: the first-decision liveness timeout (default
      // 5000ms) fails the silent stream closed, then the backoff (base = max =
      // 5ms) reconnects. Advancing to the boundaries keeps the number of fired
      // timers bounded so a slow runner does not exhaust the real test timeout.
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(5000);
      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });

      await jest.advanceTimersByTimeAsync(5);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      sub.unsubscribe();
    });

    test('whenStreamGoesSilentAfterFirstDecisionThenIndeterminateAndReconnect', async () => {
      const fetchMock = jest.fn().mockResolvedValue(sseResponse([permitFrame], { keepOpen: true }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const emissions: AuthorizationDecision[] = [];
      const sub = newClient()
        .decide(SUBSCRIPTION)
        .subscribe({ next: (decision) => emissions.push(decision) });

      // One PERMIT arrives, then the connection stalls (no further frames, no FIN).
      // The inactivity liveness timeout (default 60000ms) trips, then the backoff
      // (base = max = 5ms) reconnects. Advance to the exact boundaries.
      await jest.advanceTimersByTimeAsync(0);
      expect(emissions).toContainEqual({ decision: 'PERMIT' });

      await jest.advanceTimersByTimeAsync(60_000);
      // Inactivity must not leave the consumer pinned to the stale PERMIT.
      expect(emissions).toContainEqual({ decision: 'INDETERMINATE' });

      await jest.advanceTimersByTimeAsync(5);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      sub.unsubscribe();
    });
  });

  describe('reconnect counter resets after a healthy decision (CR-08)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test('whenEveryOutageFollowsADecisionThenReconnectsStayAtAttemptOneWarnLevel', async () => {
      // Every connection delivers a decision then briefly drops. Because each
      // outage is preceded by a successful decision, the failure counter must
      // reset, so reconnects never escalate to ERROR nor climb the backoff.
      const fetchMock = jest.fn().mockImplementation(async () => sseResponse([permitFrame]));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      // Pin the backoff jitter so every reconnect waits exactly the base delay
      // (base = max = 5ms) and each advance fires precisely one reconnect.
      jest.spyOn(Math, 'random').mockReturnValue(0.999);

      const sub = newClient()
        .decide(SUBSCRIPTION)
        .subscribe({ next: () => undefined });

      await jest.advanceTimersByTimeAsync(0);
      for (let cycle = 0; cycle < 8; cycle++) {
        await jest.advanceTimersByTimeAsync(5);
      }
      sub.unsubscribe();

      const reconnectErrors = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('reconnecting'));
      const reconnectWarns = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('reconnecting'));

      // Drove well past the escalation threshold of five reconnects.
      expect(reconnectWarns.length).toBeGreaterThanOrEqual(5);
      // A reconnect that follows a healthy decision never escalates to ERROR.
      expect(reconnectErrors).toHaveLength(0);
      // Backoff restarts at base delay every time, i.e. always attempt one.
      for (const message of reconnectWarns) {
        expect(message).toContain('attempt 1)');
      }
    });
  });

  describe('multi-decide-all rejects duplicate subscription ids fail-closed (DVW-11)', () => {
    test('whenSnapshotPayloadRepeatsAnIdThenRejectedRatherThanLastWinsMerged', async () => {
      const duplicateWire = '{"a":{"decision":"PERMIT"},"a":{"decision":"DENY"}}';
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => duplicateWire,
        json: async () => JSON.parse(duplicateWire),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await newClient().multiDecideAllOnce({
        subscriptions: { a: SUBSCRIPTION },
      });

      // Spring refuses the whole payload on a duplicate id. The port must not
      // silently keep the last-wins DENY.
      expect(result.decisions.a?.decision).not.toBe('DENY');
      expect(result.decisions).toEqual({});
    });
  });
});

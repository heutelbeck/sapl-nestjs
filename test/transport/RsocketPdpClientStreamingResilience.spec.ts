import { Logger } from '@nestjs/common';

type StreamHandler = {
  onNext: (payload: { data?: Buffer }, isComplete: boolean) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
  onExtension: () => void;
};

/**
 * Controllable RSocket stand-in. Records each requestStream subscription so a
 * test can drive the server-side callbacks and observe whether the client tears
 * down and re-opens the stream (reconnect) or keeps the same subscription alive.
 */
class FakeRSocket {
  readonly handlers: StreamHandler[] = [];
  requestStreamCalls = 0;

  requestStream(
    _payload: { data: Buffer; metadata: Buffer },
    _requestN: number,
    handler: StreamHandler,
  ): { cancel: () => void } {
    this.requestStreamCalls++;
    this.handlers.push(handler);
    return { cancel: () => undefined };
  }

  close(): void {
    /* no-op for the fake */
  }
}

const fakeSocket = new FakeRSocket();

jest.mock('@rsocket/core', () => ({
  ...jest.requireActual('@rsocket/core'),
  RSocketConnector: jest.fn().mockImplementation(() => ({
    connect: () => Promise.resolve(fakeSocket),
  })),
}));

// Decode decisions from JSON bytes so a test can hand the stream a deliberately
// undecodable frame (non-JSON) and trigger the decode-failure path, while valid
// frames carry a real decision payload.
jest.mock('../../lib/transport/codec/SaplProtoCodec', () => ({
  SaplProtoCodec: class {
    encodeSubscription(): Buffer {
      return Buffer.from('subscription');
    }
    decodeDecision(buffer: Buffer): unknown {
      return JSON.parse(buffer.toString('utf8'));
    }
  },
}));

import { RsocketPdpClient } from '../../lib/transport/RsocketPdpClient';
import type { AuthorizationDecision } from '../../lib/types';

const SUBSCRIPTION = { subject: 'alice', action: 'read', resource: 'doc-1' };
const INDETERMINATE: AuthorizationDecision = { decision: 'INDETERMINATE' };
const frame = (decision: AuthorizationDecision): Buffer => Buffer.from(JSON.stringify(decision), 'utf8');

interface StreamObservation {
  readonly emissions: AuthorizationDecision[];
  terminalError: Error | null;
  completed: boolean;
  unsubscribe: () => void;
}

describe('RsocketPdpClient streaming resilience: first-decision timeout, decode substitution, outage escalation', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    fakeSocket.handlers.length = 0;
    fakeSocket.requestStreamCalls = 0;
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function newClient(timeoutMs = 200): RsocketPdpClient {
    return new RsocketPdpClient({
      host: 'localhost',
      port: 7000,
      timeoutMs,
      streamingRetryBaseDelayMs: 50,
      streamingRetryMaxDelayMs: 50,
    });
  }

  async function subscribeAndOpenStream(client: RsocketPdpClient): Promise<StreamObservation> {
    const state: StreamObservation = {
      emissions: [],
      terminalError: null,
      completed: false,
      unsubscribe: () => undefined,
    };
    const sub = client.decide(SUBSCRIPTION).subscribe({
      next: (decision) => state.emissions.push(decision),
      error: (error) => {
        state.terminalError = error;
      },
      complete: () => {
        state.completed = true;
      },
    });
    state.unsubscribe = () => sub.unsubscribe();
    // Flush connect() so requestStream registers its handler.
    await jest.advanceTimersByTimeAsync(0);
    return state;
  }

  describe('when a live server accepts the stream but never emits the first decision', () => {
    // CR-11-RSOCKET: a connection whose RSocket layer is alive (keepalive acked)
    // but which withholds the first decision must be bounded by a first-decision
    // timeout, fail closed with INDETERMINATE, and reconnect.
    test('whenFirstDecisionNeverArrivesThenEmitsIndeterminateAndReconnects', async () => {
      const client = newClient(200);
      const state = await subscribeAndOpenStream(client);

      expect(fakeSocket.requestStreamCalls).toBe(1);

      // Server stays connected but produces no decision frame. Advance past the
      // first-decision timeout, then past the reconnect backoff.
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(50);
      await jest.advanceTimersByTimeAsync(0);

      expect(state.emissions).toContainEqual(INDETERMINATE);
      expect(fakeSocket.requestStreamCalls).toBe(2);
      expect(state.terminalError).toBeNull();
      expect(state.completed).toBe(false);

      state.unsubscribe();
    });
  });

  describe('when the server emits an undecodable decision frame mid-stream', () => {
    // CR-14-RSOCKET-DECODE: a single decode failure must substitute INDETERMINATE
    // for that one item and leave the subscription intact; the same stream keeps
    // delivering subsequent server frames instead of tearing down and reconnecting.
    test('whenOneFrameFailsToDecodeThenSubstitutesIndeterminateAndKeepsSameStream', async () => {
      const client = newClient();
      const state = await subscribeAndOpenStream(client);
      const handler = fakeSocket.handlers[0];

      handler.onNext({ data: frame({ decision: 'PERMIT' }) }, false);
      handler.onNext({ data: Buffer.from('not-json', 'utf8') }, false);

      // Allow any (incorrect) reconnect backoff window to elapse.
      await jest.advanceTimersByTimeAsync(50);
      await jest.advanceTimersByTimeAsync(0);

      // The original stream is still live: a further server frame is delivered
      // on the SAME handler without a new requestStream being opened.
      handler.onNext({ data: frame({ decision: 'DENY' }) }, false);
      await jest.advanceTimersByTimeAsync(0);

      expect(fakeSocket.requestStreamCalls).toBe(1);
      expect(state.emissions).toEqual([{ decision: 'PERMIT' }, INDETERMINATE, { decision: 'DENY' }]);
      expect(state.terminalError).toBeNull();
      expect(state.completed).toBe(false);

      state.unsubscribe();
    });
  });

  describe('when a sustained RSocket outage forces repeated reconnects', () => {
    // CR-10-RSOCKET-ESCALATION: reconnect logging must escalate WARN -> ERROR once
    // the consecutive-failure count reaches the escalation threshold (5), so a
    // sustained outage is alertable while the client still retries forever.
    test('whenReconnectAttemptsReachEscalationThresholdThenLogsAtErrorLevel', async () => {
      const client = newClient();
      const state = await subscribeAndOpenStream(client);

      for (let attempt = 0; attempt < 6; attempt++) {
        const handler = fakeSocket.handlers[fakeSocket.handlers.length - 1];
        handler.onError(new Error('connection reset'));
        await jest.advanceTimersByTimeAsync(50);
        await jest.advanceTimersByTimeAsync(0);
      }

      const errorMessages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(errorMessages.some((message) => /attempt 5/.test(message))).toBe(true);

      state.unsubscribe();
    });
  });
});

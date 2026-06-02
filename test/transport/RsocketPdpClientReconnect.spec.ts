type StreamHandler = {
  onNext: (payload: { data?: Buffer }, isComplete: boolean) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
  onExtension: () => void;
};

/**
 * Records every requestStream subscription against the fake socket so a test
 * can drive the server-side callbacks (onComplete / onError) and assert that
 * the client reconnects rather than terminating the consumer's Observable.
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
let connectCalls = 0;

jest.mock('@rsocket/core', () => ({
  // Preserve the real module so transitive dependents (e.g. @rsocket/tcp-client,
  // which extends base classes from this module) still resolve. Only the
  // connector is replaced so connect() yields the controllable fake socket.
  ...jest.requireActual('@rsocket/core'),
  RSocketConnector: jest.fn().mockImplementation(() => ({
    connect: () => {
      connectCalls++;
      return Promise.resolve(fakeSocket);
    },
  })),
}));

import { RsocketPdpClient } from '../../lib/transport/RsocketPdpClient';
import type { AuthorizationDecision } from '../../lib/types';

const SUBSCRIPTION = { subject: 'alice', action: 'read', resource: 'doc-1' };

describe('RsocketPdpClient streaming resilience contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fakeSocket.handlers.length = 0;
    fakeSocket.requestStreamCalls = 0;
    connectCalls = 0;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function newClient(): RsocketPdpClient {
    return new RsocketPdpClient({
      host: 'localhost',
      port: 7000,
      streamingRetryBaseDelayMs: 50,
      streamingRetryMaxDelayMs: 50,
    });
  }

  interface StreamObservation {
    readonly emissions: AuthorizationDecision[];
    terminalError: Error | null;
    completed: boolean;
    readonly unsubscribe: () => void;
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
    (state as { unsubscribe: () => void }).unsubscribe = () => sub.unsubscribe();
    // Flush the connect() promise so requestStream registers its handler.
    await jest.advanceTimersByTimeAsync(0);
    return state;
  }

  test('whenServerStreamCompletesThenEmitsIndeterminateAndReconnects', async () => {
    const client = newClient();
    const state = await subscribeAndOpenStream(client);

    expect(fakeSocket.requestStreamCalls).toBe(1);

    // Server signals end-of-stream. The client must NOT complete the consumer;
    // it emits INDETERMINATE and reconnects after the backoff delay.
    fakeSocket.handlers[0].onComplete();
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(0);

    expect(state.emissions).toContainEqual({ decision: 'INDETERMINATE' });
    // Reconnect re-runs the connect path and opens a fresh requestStream
    // against the socket rather than surfacing a terminal error to the consumer.
    expect(connectCalls).toBeGreaterThanOrEqual(1);
    expect(fakeSocket.requestStreamCalls).toBe(2);
    expect(state.terminalError).toBeNull();
    expect(state.completed).toBe(false);

    state.unsubscribe();
  });

  test('whenServerStreamErrorsThenEmitsIndeterminateAndReconnects', async () => {
    const client = newClient();
    const state = await subscribeAndOpenStream(client);

    expect(fakeSocket.requestStreamCalls).toBe(1);

    // Transport-level error. Same contract: fail-closed INDETERMINATE, reconnect,
    // never surface a terminal error to the subscriber.
    fakeSocket.handlers[0].onError(new Error('connection reset'));
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(0);

    expect(state.emissions).toContainEqual({ decision: 'INDETERMINATE' });
    expect(fakeSocket.requestStreamCalls).toBe(2);
    expect(state.terminalError).toBeNull();
    expect(state.completed).toBe(false);

    state.unsubscribe();
  });

  test('whenServerRepeatedlyDropsTheStreamThenReconnectsForeverWithoutTerminating', async () => {
    const client = newClient();
    const state = await subscribeAndOpenStream(client);

    // Drop the stream far more times than any finite retry budget would allow.
    for (let attempt = 0; attempt < 8; attempt++) {
      fakeSocket.handlers[fakeSocket.handlers.length - 1].onError(new Error('reset'));
      await jest.advanceTimersByTimeAsync(50);
      await jest.advanceTimersByTimeAsync(0);
    }

    expect(fakeSocket.requestStreamCalls).toBeGreaterThanOrEqual(8);
    expect(state.emissions).toContainEqual({ decision: 'INDETERMINATE' });
    expect(state.terminalError).toBeNull();
    expect(state.completed).toBe(false);

    state.unsubscribe();
  });

  test('whenConsumerUnsubscribesDuringBackoffThenNoFurtherReconnect', async () => {
    const client = newClient();
    const state = await subscribeAndOpenStream(client);

    fakeSocket.handlers[0].onError(new Error('reset'));
    // Unsubscribe inside the backoff window, before the reconnect fires.
    state.unsubscribe();

    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(0);

    // The only request was the original one. The consumer unsubscribing is the
    // sole thing that ends the subscription.
    expect(fakeSocket.requestStreamCalls).toBe(1);
    expect(state.completed).toBe(false);
  });
});

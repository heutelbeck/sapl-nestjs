import { Logger } from '@nestjs/common';
import { RSocket, RSocketConnector } from '@rsocket/core';
import {
  WellKnownMimeType,
  encodeBearerAuthMetadata,
  encodeSimpleAuthMetadata,
} from '@rsocket/composite-metadata';
import { TcpClientTransport } from '@rsocket/tcp-client';
import * as tls from 'node:tls';
import * as net from 'node:net';
import { Observable } from 'rxjs';
import type {
  AuthorizationDecision,
  AuthorizationSubscription,
  IdentifiableAuthorizationDecision,
  MultiAuthorizationDecision,
  MultiAuthorizationSubscription,
} from '../types';
import { SaplProtoCodec } from './codec/SaplProtoCodec';
import type { PdpClient } from './PdpClient';
import type { TlsConfig } from './TlsConfig';
import { PDP_ROUTE } from '../sapl.constants';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopback = (host: string): boolean => LOOPBACK_HOSTS.has(host.toLowerCase());

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_KEEPALIVE_LIFETIME_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5000;

const ERROR_RSOCKET_HOST_REQUIRED = 'RsocketPdpClient requires a non-empty host.';
const ERROR_RSOCKET_PORT_REQUIRED = 'RsocketPdpClient requires a positive port number.';
const ERROR_RSOCKET_AUTH_CONFLICT =
  'RSocket auth conflict: configure at most one of basic / apiKey / oauth2.';
const ERROR_RSOCKET_PLAINTEXT_NON_LOOPBACK =
  'RSocket transport refuses to connect plaintext (no TLS) to a non-loopback host. Configure tls or move the PDP to localhost.';

// Lazy module-level codec so HTTP-only consumers never load protobuf.
let sharedCodec: SaplProtoCodec | null = null;
const getCodec = (): SaplProtoCodec => {
  if (sharedCodec === null) {
    sharedCodec = new SaplProtoCodec();
  }
  return sharedCodec;
};

export interface RsocketPdpClientOptions {
  readonly host: string;
  readonly port: number;
  readonly basic?: { readonly username: string; readonly password: string };
  readonly apiKey?: string;
  readonly oauth2Token?: () => Promise<string>;
  readonly keepAliveIntervalMs?: number;
  readonly keepAliveLifetimeMs?: number;
  /**
   * Per-request timeout in milliseconds. Bounds `requestResponse` calls
   * that would otherwise hang forever on a stalled server. Defaults to
   * 5000ms.
   */
  readonly timeoutMs?: number;
  /**
   * Optional TLS configuration. Without this the transport refuses to
   * connect to a non-loopback host (plaintext over TCP across the
   * network is unsafe).
   */
  readonly tls?: TlsConfig;
}

/**
 * RSocket / Protobuf transport against a SAPL Node listening on its
 * RSocket port. Per-request composite metadata routes the call; per-request
 * auth metadata (when configured) injects credentials. The socket is
 * lazily opened on first call and cached for the client's lifetime; calls
 * issued during a re-connect wait for the in-flight connection promise.
 */
export class RsocketPdpClient implements PdpClient {
  private readonly logger = new Logger(RsocketPdpClient.name);
  private readonly keepAliveInterval: number;
  private readonly keepAliveLifetime: number;
  private readonly timeoutMs: number;
  private socketPromise: Promise<RSocket> | null = null;

  constructor(private readonly options: RsocketPdpClientOptions) {
    if (!options.host || options.host.trim() === '') {
      throw new Error(ERROR_RSOCKET_HOST_REQUIRED);
    }
    if (!options.port || options.port <= 0) {
      throw new Error(ERROR_RSOCKET_PORT_REQUIRED);
    }
    const configuredAuthSources = [options.basic, options.apiKey, options.oauth2Token].filter(
      (value) => value !== undefined,
    ).length;
    if (configuredAuthSources > 1) {
      throw new Error(ERROR_RSOCKET_AUTH_CONFLICT);
    }
    if (!options.tls && !isLoopback(options.host)) {
      throw new Error(`${ERROR_RSOCKET_PLAINTEXT_NON_LOOPBACK} host: ${options.host}`);
    }
    this.keepAliveInterval = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.keepAliveLifetime = options.keepAliveLifetimeMs ?? DEFAULT_KEEPALIVE_LIFETIME_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision> {
    return this.requestResponseOnce(
      PDP_ROUTE.DECIDE_ONCE,
      getCodec().encodeSubscription(subscription),
      (data) => getCodec().decodeDecision(data),
      { decision: 'INDETERMINATE' },
      'decideOnce',
    );
  }

  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision> {
    // Subscribers needing fail-closed semantics compose with `catchError`.
    return this.requestStreamObs(
      PDP_ROUTE.DECIDE,
      getCodec().encodeSubscription(subscription),
      (data) => getCodec().decodeDecision(data),
      undefined,
      'decide',
    );
  }

  async multiDecideAllOnce(
    subscription: MultiAuthorizationSubscription,
  ): Promise<MultiAuthorizationDecision> {
    return this.requestResponseOnce(
      PDP_ROUTE.MULTI_DECIDE_ALL_ONCE,
      getCodec().encodeMultiSubscription(subscription),
      (data) => getCodec().decodeMultiDecision(data),
      { decisions: {} },
      'multiDecideAllOnce',
    );
  }

  multiDecide(subscription: MultiAuthorizationSubscription): Observable<IdentifiableAuthorizationDecision> {
    return this.requestStreamObs(
      PDP_ROUTE.MULTI_DECIDE,
      getCodec().encodeMultiSubscription(subscription),
      (data) => getCodec().decodeIdentifiableDecision(data),
      undefined,
      'multiDecide',
    );
  }

  multiDecideAll(subscription: MultiAuthorizationSubscription): Observable<MultiAuthorizationDecision> {
    return this.requestStreamObs(
      PDP_ROUTE.MULTI_DECIDE_ALL,
      getCodec().encodeMultiSubscription(subscription),
      (data) => getCodec().decodeMultiDecision(data),
      undefined,
      'multiDecideAll',
    );
  }

  /**
   * Shared requestResponse path used by decideOnce + multiDecideAllOnce.
   * Connects, sends, awaits exactly one payload (or timeout), decodes,
   * fail-closes to the supplied fallback on any failure.
   */
  private async requestResponseOnce<TOut>(
    route: string,
    data: Buffer,
    decoder: (raw: Buffer) => TOut,
    fallback: TOut,
    label: string,
  ): Promise<TOut> {
    try {
      const socket = await this.connect();
      const metadata = await this.buildMetadata(route);
      let cancellable: { cancel: () => void } | null = null;
      const operation = new Promise<TOut>((resolve) => {
        cancellable = socket.requestResponse(
          { data, metadata },
          {
            onNext: (payload, _isComplete) => {
              if (!payload.data) {
                resolve(fallback);
                return;
              }
              try {
                resolve(decoder(payload.data));
              } catch (error) {
                this.logger.error(`RSocket ${label} decode failure: ${String(error)}`);
                resolve(fallback);
              }
            },
            onError: (error) => {
              this.logger.error(`RSocket ${label} error: ${error.message}`);
              resolve(fallback);
            },
            onComplete: () => undefined,
            onExtension: () => undefined,
          },
        );
      });
      return await this.withTimeout(operation, () => cancellable?.cancel(), label, fallback);
    } catch (error) {
      this.logger.error(`RSocket ${label} transport failure: ${String(error)}`);
      return fallback;
    }
  }

  /**
   * Shared requestStream path used by decide + multiDecide + multiDecideAll.
   * Cold Observable that connects + subscribes on each subscription;
   * unsubscribing the consumer cancels the underlying RSocket stream.
   * `fallbackOnError` (when defined) is emitted before the error to
   * keep fail-closed callers from seeing a missing terminal value.
   */
  private requestStreamObs<TOut>(
    route: string,
    data: Buffer,
    decoder: (raw: Buffer) => TOut,
    fallbackOnError: TOut | undefined,
    label: string,
  ): Observable<TOut> {
    return new Observable<TOut>((subscriber) => {
      let cancellable: { cancel: () => void } | null = null;
      let cancelled = false;
      this.connect()
        .then(async (socket) => {
          if (cancelled) return;
          const metadata = await this.buildMetadata(route);
          cancellable = socket.requestStream({ data, metadata }, 0x7fffffff, {
            onNext: (payload, isComplete) => {
              if (payload.data) {
                try {
                  subscriber.next(decoder(payload.data));
                } catch (error) {
                  this.logger.error(`RSocket ${label} decode failure: ${String(error)}`);
                  if (fallbackOnError !== undefined) subscriber.next(fallbackOnError);
                }
              }
              if (isComplete) {
                subscriber.complete();
              }
            },
            onError: (error) => {
              if (fallbackOnError !== undefined) subscriber.next(fallbackOnError);
              subscriber.error(new Error(`RSocket ${label} failed`, { cause: error }));
            },
            onComplete: () => subscriber.complete(),
            onExtension: () => undefined,
          });
        })
        .catch((error: unknown) => {
          if (fallbackOnError !== undefined) subscriber.next(fallbackOnError);
          subscriber.error(new Error(`RSocket ${label} transport failure`, { cause: error }));
        });
      return () => {
        cancelled = true;
        cancellable?.cancel();
      };
    });
  }

  async close(): Promise<void> {
    if (this.socketPromise === null) return;
    const promise = this.socketPromise;
    this.socketPromise = null;
    try {
      const socket = await promise;
      socket.close();
    } catch {
      /* socket never opened; nothing to release */
    }
  }

  private connect(): Promise<RSocket> {
    if (this.socketPromise !== null) {
      return this.socketPromise;
    }
    // Clear the cached promise on rejection so the next call retries
    // instead of awaiting a forever-rejected promise.
    const fresh = (async () => {
      const setupMetadata = await this.buildSetupAuthMetadata();
      // Match the auth MIME only when auth is configured. Otherwise advertise
      // a neutral MIME so a future drift in conditional builds cannot
      // accidentally send a stray byte buffer under the auth MIME.
      const setup =
        setupMetadata !== null
          ? {
              dataMimeType: WellKnownMimeType.APPLICATION_PROTOBUF.string,
              metadataMimeType: WellKnownMimeType.MESSAGE_RSOCKET_AUTHENTICATION.string,
              keepAlive: this.keepAliveInterval,
              lifetime: this.keepAliveLifetime,
              payload: { data: Buffer.alloc(0), metadata: setupMetadata },
            }
          : {
              dataMimeType: WellKnownMimeType.APPLICATION_PROTOBUF.string,
              metadataMimeType: WellKnownMimeType.APPLICATION_PROTOBUF.string,
              keepAlive: this.keepAliveInterval,
              lifetime: this.keepAliveLifetime,
            };
      const connector = new RSocketConnector({
        transport: this.buildTransport(),
        setup,
      });
      return connector.connect();
    })();
    this.socketPromise = fresh.catch((error: unknown) => {
      if (this.socketPromise === fresh) {
        this.socketPromise = null;
      }
      throw error;
    });
    return this.socketPromise;
  }

  private buildTransport(): TcpClientTransport {
    const connectionOptions: net.NetConnectOpts = {
      host: this.options.host,
      port: this.options.port,
    };
    if (!this.options.tls) {
      return new TcpClientTransport({ connectionOptions });
    }
    const tlsConfig = this.options.tls;
    return new TcpClientTransport({
      connectionOptions,
      socketCreator: () =>
        tls.connect({
          host: this.options.host,
          port: this.options.port,
          ca: tlsConfig.ca,
          cert: tlsConfig.cert,
          key: tlsConfig.key,
          servername: tlsConfig.servername ?? this.options.host,
          rejectUnauthorized: tlsConfig.rejectUnauthorized ?? true,
        }),
    });
  }

  private buildMetadata(route: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(route, 'utf8'));
  }

  /**
   * Bound a requestResponse with a timeout. The connection may stay alive
   * via keepAlive while the server never produces a response frame; without
   * this guard the caller hangs. On timeout the stream is cancelled and the
   * fail-closed fallback resolves.
   */
  private async withTimeout<T>(
    operation: Promise<T>,
    cancel: () => void,
    label: string,
    fallback?: T,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        cancel();
        this.logger.error(`RSocket ${label} timed out after ${this.timeoutMs}ms`);
        if (fallback !== undefined) {
          resolve(fallback);
        } else {
          resolve({ decision: 'INDETERMINATE' } as T);
        }
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async buildSetupAuthMetadata(): Promise<Buffer | null> {
    if (this.options.basic) {
      return encodeSimpleAuthMetadata(this.options.basic.username, this.options.basic.password);
    }
    if (this.options.apiKey) {
      return encodeBearerAuthMetadata(Buffer.from(this.options.apiKey, 'utf8'));
    }
    if (this.options.oauth2Token) {
      const token = await this.options.oauth2Token();
      return encodeBearerAuthMetadata(Buffer.from(token, 'utf8'));
    }
    return null;
  }
}

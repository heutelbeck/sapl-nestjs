import { Logger } from '@nestjs/common';
import { Observable, Subscriber, distinctUntilChanged, retry, timer } from 'rxjs';
import { isDeepStrictEqual } from 'node:util';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  DECISION_SET,
  type AuthorizationDecision,
  type AuthorizationSubscription,
  type Decision,
  type IdentifiableAuthorizationDecision,
  type MultiAuthorizationDecision,
  type MultiAuthorizationSubscription,
} from '../types';
import type { PdpClient } from './PdpClient';
import type { TlsConfig } from './TlsConfig';
import { PDP_API_PREFIX, PDP_ROUTE } from '../sapl.constants';

type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };
type FetchFn = (input: string, init: RequestInitWithDispatcher) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const MAX_LOG_BODY_LENGTH = 500;
const truncateForLog = (body: string): string =>
  body.length > MAX_LOG_BODY_LENGTH ? body.substring(0, MAX_LOG_BODY_LENGTH) + '...' : body;
// SSE decision frames are <1 KB in practice. The 64 KB cap bounds memory
// against a misbehaving PDP that never terminates a frame.
const MAX_BUFFER_SIZE = 65_536;
const MAX_CONSTRAINT_COUNT = 100;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopback = (host: string): boolean => LOOPBACK_HOSTS.has(host.toLowerCase());

const ERROR_BUFFER_OVERFLOW = 'PDP streaming buffer overflow';
const ERROR_HTTP_BASE_REQUIRED = 'HttpPdpClient requires a baseUrl.';
const ERROR_HTTP_NON_LOOPBACK =
  'PDP base URL uses plain HTTP and targets a non-loopback host. Plaintext authorization decisions to a remote host are refused. Use HTTPS (https://...) or run the PDP on localhost.';
const ERROR_MIXED_AUTH =
  'PDP authentication conflict: both token and username/secret are configured. Use either Bearer token (token) or Basic Auth (username + secret), not both.';
const ERROR_PARTIAL_BASIC_AUTH = 'PDP Basic Auth requires both username and secret to be configured.';
const ERROR_STREAM_ENDED = 'PDP decision stream ended unexpectedly';
const ERROR_STREAM_NO_BODY = 'PDP streaming response has no body';

const WARN_LOOPBACK_PLAINTEXT_HTTP =
  'PDP connection uses unencrypted HTTP on loopback. Acceptable for local dev; production must use HTTPS.';

/**
 * Per-instance fetch resolver. When a TLS dispatcher is configured the
 * undici fetch is required because Node's built-in fetch (Node 20+)
 * ships a bundled undici whose `dispatcher` ABI may not match the
 * userland `undici` package version. When no dispatcher is configured
 * we keep the global fetch so test-time stubs of `globalThis.fetch`
 * still intercept calls.
 */
const pickFetch = (dispatcher: Dispatcher | undefined): FetchFn =>
  dispatcher ? (undiciFetch as unknown as FetchFn) : (globalThis.fetch as FetchFn);

function buildTlsDispatcher(tls: TlsConfig): Dispatcher {
  return new Agent({
    connect: {
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      rejectUnauthorized: tls.rejectUnauthorized ?? true,
    },
  });
}

function summariseSubscription(subscription: AuthorizationSubscription): object {
  const fields = Object.keys(subscription).filter((field) => field !== 'secrets');
  return { fields, action: typeof subscription.action === 'string' ? subscription.action : '<non-string>' };
}

function summariseMultiSubscription(subscription: MultiAuthorizationSubscription): object {
  const ids = Object.keys(subscription.subscriptions);
  return { count: ids.length, ids };
}

function warnIfConstraintArrayOversized(label: string, value: unknown[], logger: Logger): void {
  if (value.length > MAX_CONSTRAINT_COUNT) {
    logger.warn(
      `PDP decision carries ${value.length} ${label} (>${MAX_CONSTRAINT_COUNT}). ` +
        'Verify the policy authoring; the client will still dispatch them but operators should investigate.',
    );
  }
}

function validateDecision(raw: unknown, logger: Logger): AuthorizationDecision {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP response is not an object, returning INDETERMINATE');
    return { decision: 'INDETERMINATE' };
  }
  const fields = raw as Record<string, unknown>;
  if (typeof fields.decision !== 'string' || !DECISION_SET.has(fields.decision as Decision)) {
    logger.warn(
      `PDP response has invalid decision field: ${JSON.stringify(fields.decision)}, returning INDETERMINATE`,
    );
    return { decision: 'INDETERMINATE' };
  }
  const decision: AuthorizationDecision = { decision: fields.decision as Decision };
  if (Array.isArray(fields.obligations)) {
    warnIfConstraintArrayOversized('obligations', fields.obligations, logger);
    decision.obligations = fields.obligations;
  }
  if (Array.isArray(fields.advice)) {
    warnIfConstraintArrayOversized('advice', fields.advice, logger);
    decision.advice = fields.advice;
  }
  if (fields.resource !== undefined) decision.resource = fields.resource;
  return decision;
}

function validateIdentifiableDecision(
  raw: unknown,
  logger: Logger,
): IdentifiableAuthorizationDecision | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP multi-decide response is not an object, skipping');
    return null;
  }
  const fields = raw as Record<string, unknown>;
  if (typeof fields.subscriptionId !== 'string' || fields.subscriptionId === '') {
    logger.warn('PDP multi-decide response has invalid subscriptionId, skipping');
    return null;
  }
  const decision = validateDecision(fields.decision, logger);
  return { subscriptionId: fields.subscriptionId, decision };
}

function validateMultiDecision(raw: unknown, logger: Logger): MultiAuthorizationDecision | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP multi-decide-all response is not an object, skipping');
    return null;
  }
  const decisions: Record<string, AuthorizationDecision> = {};
  for (const [id, rawDecision] of Object.entries(raw as Record<string, unknown>)) {
    decisions[id] = validateDecision(rawDecision, logger);
  }
  return { decisions };
}

/**
 * Optional dynamic-bearer token provider. When configured, the
 * Authorization header is built per request from `getAccessToken()`.
 * A 401 from the PDP triggers `invalidate()` and a single retry.
 */
export interface BearerTokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

export interface HttpPdpClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly username?: string;
  readonly secret?: string;
  /**
   * Dynamic bearer-token resolver. Takes precedence over `token` /
   * `username` / `secret` when present. Use with `OAuth2TokenProvider`
   * for client_credentials + refresh against an OIDC issuer.
   */
  readonly tokenProvider?: BearerTokenProvider;
  readonly timeout?: number;
  readonly streamingMaxRetries?: number;
  readonly streamingRetryBaseDelay?: number;
  readonly streamingRetryMaxDelay?: number;
  /**
   * Optional TLS configuration applied when `baseUrl` is HTTPS.
   * Without this the client uses Node's default trust store.
   */
  readonly tls?: TlsConfig;
}

export class HttpPdpClient implements PdpClient {
  private readonly logger = new Logger(HttpPdpClient.name);
  private readonly timeoutMs: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly maxRetries: number;
  private readonly resolveAuthorization: () => Promise<string | null>;
  private readonly tokenProvider: BearerTokenProvider | undefined;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly decideOnceUrl: string;
  private readonly decideUrl: string;
  private readonly multiDecideUrl: string;
  private readonly multiDecideAllUrl: string;
  private readonly multiDecideAllOnceUrl: string;

  constructor(options: HttpPdpClientOptions) {
    if (!options.baseUrl) {
      throw new Error(ERROR_HTTP_BASE_REQUIRED);
    }
    const hasToken = !!options.token;
    const hasBasicAuth = !!options.username || !!options.secret;
    const hasTokenProvider = !!options.tokenProvider;
    const configuredAuthSources = [hasToken, hasBasicAuth, hasTokenProvider].filter(Boolean).length;
    if (configuredAuthSources > 1) {
      throw new Error(ERROR_MIXED_AUTH);
    }
    if (hasBasicAuth && (!options.username || !options.secret)) {
      throw new Error(ERROR_PARTIAL_BASIC_AUTH);
    }
    this.tokenProvider = options.tokenProvider;
    if (hasTokenProvider) {
      this.resolveAuthorization = async () => `Bearer ${await options.tokenProvider!.getAccessToken()}`;
    } else if (hasToken) {
      const staticHeader = `Bearer ${options.token!}`;
      this.resolveAuthorization = () => Promise.resolve(staticHeader);
    } else if (hasBasicAuth) {
      const encoded = Buffer.from(`${options.username!}:${options.secret!}`).toString('base64');
      const staticHeader = `Basic ${encoded}`;
      this.resolveAuthorization = () => Promise.resolve(staticHeader);
    } else {
      this.resolveAuthorization = () => Promise.resolve(null);
    }
    const parsedUrl = new URL(options.baseUrl);
    if (parsedUrl.protocol === 'http:') {
      if (!isLoopback(parsedUrl.hostname)) {
        throw new Error(`${ERROR_HTTP_NON_LOOPBACK} URL: ${options.baseUrl}`);
      }
      this.logger.warn(WARN_LOOPBACK_PLAINTEXT_HTTP);
    }
    this.dispatcher = options.tls ? buildTlsDispatcher(options.tls) : undefined;
    this.decideOnceUrl = new URL(PDP_API_PREFIX + PDP_ROUTE.DECIDE_ONCE, options.baseUrl).toString();
    this.decideUrl = new URL(PDP_API_PREFIX + PDP_ROUTE.DECIDE, options.baseUrl).toString();
    this.multiDecideUrl = new URL(PDP_API_PREFIX + PDP_ROUTE.MULTI_DECIDE, options.baseUrl).toString();
    this.multiDecideAllUrl = new URL(PDP_API_PREFIX + PDP_ROUTE.MULTI_DECIDE_ALL, options.baseUrl).toString();
    this.multiDecideAllOnceUrl = new URL(
      PDP_API_PREFIX + PDP_ROUTE.MULTI_DECIDE_ALL_ONCE,
      options.baseUrl,
    ).toString();
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retryBaseDelay = options.streamingRetryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelay = options.streamingRetryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.maxRetries = options.streamingMaxRetries ?? Infinity;
    this.logger.log(`HttpPdpClient configured at ${options.baseUrl}`);
  }

  async decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision> {
    const safeForLog = summariseSubscription(subscription);
    this.logger.debug(`Requesting decision: ${JSON.stringify(safeForLog)}`);
    const raw = await this.fetchOnce(this.decideOnceUrl, JSON.stringify(subscription));
    if (raw === null) return { decision: 'INDETERMINATE' };
    // Log only the verb. Obligations / advice / resource may carry PII.
    const verb = (raw as { decision?: unknown })?.decision;
    this.logger.debug(`Decision: ${typeof verb === 'string' ? verb : 'INVALID'}`);
    return validateDecision(raw, this.logger);
  }

  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision> {
    const safeForLog = summariseSubscription(subscription);
    this.logger.debug(`Streaming subscription: ${JSON.stringify(safeForLog)}`);
    const indeterminate: AuthorizationDecision = { decision: 'INDETERMINATE' };
    return this.streamSse(
      this.decideUrl,
      JSON.stringify(subscription),
      (parsed) => validateDecision(parsed, this.logger),
      (subscriber) => subscriber.next(indeterminate),
    );
  }

  async multiDecideAllOnce(
    subscription: MultiAuthorizationSubscription,
  ): Promise<MultiAuthorizationDecision> {
    this.logger.debug(
      `Requesting multi-decide-all-once: ${JSON.stringify(summariseMultiSubscription(subscription))}`,
    );
    const raw = await this.fetchOnce(this.multiDecideAllOnceUrl, JSON.stringify(subscription.subscriptions));
    if (raw === null) return { decisions: {} };
    const summary = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([id, dec]) => [
        id,
        (dec as { decision?: unknown })?.decision ?? 'INVALID',
      ]),
    );
    this.logger.debug(`Multi-decide-all-once result: ${JSON.stringify(summary)}`);
    return validateMultiDecision(raw, this.logger) ?? { decisions: {} };
  }

  multiDecide(subscription: MultiAuthorizationSubscription): Observable<IdentifiableAuthorizationDecision> {
    return this.streamMulti(
      this.multiDecideUrl,
      subscription,
      (parsed) => validateIdentifiableDecision(parsed, this.logger),
      (subscriber) => {
        for (const subscriptionId of Object.keys(subscription.subscriptions)) {
          subscriber.next({ subscriptionId, decision: { decision: 'INDETERMINATE' } });
        }
      },
    );
  }

  multiDecideAll(subscription: MultiAuthorizationSubscription): Observable<MultiAuthorizationDecision> {
    return this.streamMulti(
      this.multiDecideAllUrl,
      subscription,
      (parsed) => validateMultiDecision(parsed, this.logger),
      (subscriber) => {
        const decisions: Record<string, AuthorizationDecision> = {};
        for (const id of Object.keys(subscription.subscriptions)) {
          decisions[id] = { decision: 'INDETERMINATE' };
        }
        subscriber.next({ decisions });
      },
    );
  }

  private streamMulti<T>(
    url: string,
    subscription: MultiAuthorizationSubscription,
    validate: (parsed: unknown) => T | null,
    seed: (subscriber: Subscriber<T>) => void,
  ): Observable<T> {
    this.logger.debug(
      `Streaming multi from ${url}: ${JSON.stringify(summariseMultiSubscription(subscription))}`,
    );
    return this.streamSse(url, JSON.stringify(subscription.subscriptions), validate, seed);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Invalidates the token-provider cache so the next call acquires a fresh
   * token. Returns true when a refresh may help (provider configured),
   * false otherwise.
   */
  private handleAuthFailure(): boolean {
    if (!this.tokenProvider) {
      return false;
    }
    this.tokenProvider.invalidate();
    return true;
  }

  private async fetchOnce(url: string, body: string, retried = false): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const authorization = await this.resolveAuthorization();
      if (authorization) {
        headers['Authorization'] = authorization;
      }
      const response = await pickFetch(this.dispatcher)(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      if (!response.ok) {
        let responseBody = '';
        try {
          responseBody = await response.text();
        } catch {
          /* ignore unreadable body */
        }
        this.logger.error(
          `PDP returned HTTP ${response.status} (${response.statusText}) for ${url}` +
            (responseBody ? ` -- body: ${truncateForLog(responseBody)}` : ''),
        );
        if (response.status === 401 || response.status === 403) {
          this.logger.error('PDP authentication failed. Check token or username/secret configuration.');
          if (this.handleAuthFailure() && !retried) {
            return this.fetchOnce(url, body, true);
          }
        }
        return null;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(`PDP request to ${url} timed out after ${this.timeoutMs}ms`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const cause = (error as { cause?: unknown })?.cause;
        const causeDetail = cause
          ? ` cause=${JSON.stringify({ name: (cause as Error)?.name, message: (cause as Error)?.message, code: (cause as { code?: string }).code })}`
          : '';
        this.logger.error(`PDP request to ${url} failed: ${message}${causeDetail}`);
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private streamSse<T>(
    url: string,
    body: string,
    validate: (parsed: unknown) => T | null,
    onStreamError?: (subscriber: Subscriber<T>) => void,
  ): Observable<T> {
    const emitError = (subscriber: Subscriber<T>, error: Error) => {
      if (onStreamError) onStreamError(subscriber);
      subscriber.error(error);
    };
    const singleAttempt$ = new Observable<T>((subscriber) => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const connectTimeout = setTimeout(() => controller.abort(), this.timeoutMs);
      (async () => {
        const authorization = await this.resolveAuthorization();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        if (authorization) {
          headers['Authorization'] = authorization;
        }
        return pickFetch(this.dispatcher)(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
          dispatcher: this.dispatcher,
        });
      })()
        .then(async (response) => {
          clearTimeout(connectTimeout);
          if (!response.ok) {
            let responseBody = '';
            try {
              responseBody = await response.text();
            } catch {
              /* ignore unreadable body */
            }
            const statusMsg =
              `PDP returned HTTP ${response.status} (${response.statusText}) for ${url}` +
              (responseBody ? ` -- body: ${truncateForLog(responseBody)}` : '');
            this.logger.error(statusMsg);
            if (response.status === 401 || response.status === 403) {
              this.logger.error(
                'PDP authentication failed. Check token or username/secret configuration. Retrying with backoff.',
              );
              this.handleAuthFailure();
            }
            emitError(subscriber, new Error(`PDP returned HTTP ${response.status}`));
            return;
          }
          if (!response.body) {
            this.logger.error(ERROR_STREAM_NO_BODY);
            emitError(subscriber, new Error(ERROR_STREAM_NO_BODY));
            return;
          }
          reader = (response.body as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > MAX_BUFFER_SIZE) {
                this.logger.error(
                  `PDP streaming buffer exceeded ${MAX_BUFFER_SIZE} bytes. Aborting connection to prevent memory exhaustion.`,
                );
                emitError(subscriber, new Error(ERROR_BUFFER_OVERFLOW));
                return;
              }
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith(':') || trimmed === '') continue;
                const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
                if (data === '') continue;
                let parsed: unknown;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  this.logger.warn(`SSE frame is not valid JSON: ${data}`);
                  continue;
                }
                try {
                  const validated = validate(parsed);
                  if (validated !== null) subscriber.next(validated);
                } catch (validatorError) {
                  this.logger.warn(`SSE frame validator threw: ${String(validatorError)}`);
                }
              }
            }
            const trailing = buffer.trim();
            if (trailing !== '') {
              const data = trailing.startsWith('data:') ? trailing.slice(5).trim() : trailing;
              if (data !== '') {
                try {
                  const parsed = JSON.parse(data);
                  const validated = validate(parsed);
                  if (validated !== null) subscriber.next(validated);
                } catch {
                  /* ignore trailing partial data */
                }
              }
            }
            emitError(subscriber, new Error(ERROR_STREAM_ENDED));
          } catch (error) {
            if (controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`PDP streaming read failed: ${message}`);
            emitError(subscriber, error instanceof Error ? error : new Error(String(error)));
          }
        })
        .catch((error: unknown) => {
          clearTimeout(connectTimeout);
          if (controller.signal.aborted) return;
          if (error instanceof Error && error.name === 'AbortError') {
            this.logger.error(`PDP streaming connection to ${url} timed out after ${this.timeoutMs}ms`);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`PDP streaming request to ${url} failed: ${message}`);
          }
          emitError(subscriber, error instanceof Error ? error : new Error(String(error)));
        });
      return () => {
        clearTimeout(connectTimeout);
        reader?.cancel().catch(() => undefined);
        controller.abort();
      };
    });
    return singleAttempt$.pipe(
      retry({
        count: this.maxRetries,
        delay: (_error, retryCount) => {
          const baseDelay = Math.min(this.retryBaseDelay * Math.pow(2, retryCount - 1), this.retryMaxDelay);
          const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
          this.logger.warn(
            `PDP streaming connection lost, reconnecting in ${delay}ms` +
              ` (attempt ${retryCount}${this.maxRetries === Infinity ? '' : `/${this.maxRetries}`})`,
          );
          return timer(delay);
        },
      }),
      distinctUntilChanged<T>(isDeepStrictEqual),
    );
  }
}

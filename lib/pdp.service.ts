import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable, Subscriber, distinctUntilChanged, retry, timer } from 'rxjs';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';
import {
  AuthorizationDecision,
  AuthorizationSubscription,
  Decision,
  IdentifiableAuthorizationDecision,
  MultiAuthorizationDecision,
  MultiAuthorizationSubscription,
} from './types';

function redactSecrets(subscription: MultiAuthorizationSubscription): object {
  const redacted: Record<string, object> = {};
  for (const [id, sub] of Object.entries(subscription.subscriptions)) {
    const { secrets, ...safe } = sub;
    redacted[id] = safe;
  }
  return { subscriptions: redacted };
}

const DEEP_EQUAL_MAX_DEPTH = 20;

function deepEqual(a: any, b: any, depth = 0): boolean {
  if (depth > DEEP_EQUAL_MAX_DEPTH) return false;
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i], depth + 1));
  }
  if (Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], depth + 1));
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB
const MAX_LOG_BODY_LENGTH = 500;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;
const RETRY_ESCALATION_THRESHOLD = 5;
const VALID_DECISIONS = new Set(['PERMIT', 'DENY', 'INDETERMINATE', 'NOT_APPLICABLE']);

function validateDecision(raw: unknown, logger: Logger): AuthorizationDecision {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP response is not an object, returning INDETERMINATE');
    return { decision: 'INDETERMINATE' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.decision !== 'string' || !VALID_DECISIONS.has(obj.decision)) {
    logger.warn(
      `PDP response has invalid decision field: ${JSON.stringify(obj.decision)}, returning INDETERMINATE`,
    );
    return { decision: 'INDETERMINATE' };
  }
  const result: AuthorizationDecision = { decision: obj.decision as Decision };
  if (Array.isArray(obj.obligations)) result.obligations = obj.obligations;
  if (Array.isArray(obj.advice)) result.advice = obj.advice;
  if (obj.resource !== undefined) result.resource = obj.resource;
  return result;
}

function validateIdentifiableDecision(
  raw: unknown,
  logger: Logger,
): IdentifiableAuthorizationDecision | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP multi-decide response is not an object, skipping');
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.subscriptionId !== 'string' || obj.subscriptionId === '') {
    logger.warn('PDP multi-decide response has invalid subscriptionId, skipping');
    return null;
  }
  const decision = validateDecision(obj.decision, logger);
  return { subscriptionId: obj.subscriptionId, decision };
}

function validateMultiDecision(raw: unknown, logger: Logger): MultiAuthorizationDecision | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('PDP multi-decide-all response is not an object, skipping');
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.decisions == null || typeof obj.decisions !== 'object' || Array.isArray(obj.decisions)) {
    logger.warn('PDP multi-decide-all response has invalid decisions field, skipping');
    return null;
  }
  const decisions: Record<string, AuthorizationDecision> = {};
  for (const [id, rawDecision] of Object.entries(obj.decisions as Record<string, unknown>)) {
    decisions[id] = validateDecision(rawDecision, logger);
  }
  return { decisions };
}

@Injectable()
export class PdpService {
  private readonly logger = new Logger(PdpService.name);
  private readonly timeoutMs: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly maxRetries: number;
  private readonly authorizationHeader: string | null;
  private readonly decideOnceUrl: string;
  private readonly decideUrl: string;
  private readonly multiDecideUrl: string;
  private readonly multiDecideAllUrl: string;
  private readonly multiDecideAllOnceUrl: string;

  constructor(
    @Inject(SAPL_MODULE_OPTIONS)
    private readonly options: SaplModuleOptions,
  ) {
    const hasToken = !!options.token;
    const hasBasicAuth = !!options.username || !!options.secret;
    if (hasToken && hasBasicAuth) {
      throw new Error(
        'PDP authentication conflict: both token and username/secret are configured. ' +
        'Use either Bearer token (token) or Basic Auth (username + secret), not both.',
      );
    }
    if (hasBasicAuth && (!options.username || !options.secret)) {
      throw new Error(
        'PDP Basic Auth requires both username and secret to be configured.',
      );
    }
    if (hasToken) {
      this.authorizationHeader = `Bearer ${options.token}`;
    } else if (hasBasicAuth) {
      const encoded = Buffer.from(`${options.username}:${options.secret}`).toString('base64');
      this.authorizationHeader = `Basic ${encoded}`;
    } else {
      this.authorizationHeader = null;
    }
    const parsedUrl = new URL(this.options.baseUrl);
    if (parsedUrl.protocol === 'http:') {
      if (!this.options.allowInsecureConnections) {
        throw new Error(
          `PDP base URL uses HTTP (${this.options.baseUrl}). ` +
          'SAPL PDP communication carries authorization decisions and potentially sensitive information. ' +
          'Use HTTPS or set allowInsecureConnections: true to accept the risk.',
        );
      }
      this.logger.warn(
        'PDP connection uses unencrypted HTTP. Authorization decisions and potentially sensitive ' +
        'information are transmitted in plaintext. Do not use HTTP in production.',
      );
    }
    this.decideOnceUrl = new URL('/api/pdp/decide-once', this.options.baseUrl).toString();
    this.decideUrl = new URL('/api/pdp/decide', this.options.baseUrl).toString();
    this.multiDecideUrl = new URL('/api/pdp/multi-decide', this.options.baseUrl).toString();
    this.multiDecideAllUrl = new URL('/api/pdp/multi-decide-all', this.options.baseUrl).toString();
    this.multiDecideAllOnceUrl = new URL('/api/pdp/multi-decide-all-once', this.options.baseUrl).toString();
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retryBaseDelay = options.streamingRetryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelay = options.streamingRetryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.maxRetries = options.streamingMaxRetries ?? Infinity;
    this.logger.log(`PDP configured at ${this.options.baseUrl}`);
  }

  /**
   * Sends a single authorization subscription to the PDP and returns one decision.
   *
   * Returns INDETERMINATE when the PDP is unreachable or returns an invalid response.
   * Secrets in the subscription are sent to the PDP but never logged.
   *
   * @param subscription - The authorization subscription to evaluate.
   * @returns A single authorization decision.
   */
  async decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision> {
    const { secrets, ...safeForLog } = subscription;
    this.logger.debug(`Requesting decision: ${JSON.stringify(safeForLog)}`);
    const raw = await this.fetchOnce(this.decideOnceUrl, JSON.stringify(subscription));
    if (raw === null) return { decision: 'INDETERMINATE' };
    this.logger.debug(`Decision: ${JSON.stringify(raw)}`);
    return validateDecision(raw, this.logger);
  }

  /**
   * Opens a streaming SSE connection to the PDP for continuous authorization decisions.
   *
   * Emits a new {@link AuthorizationDecision} whenever the PDP re-evaluates the subscription.
   * Consecutive duplicate decisions are suppressed. On connection loss, emits INDETERMINATE
   * (fail-closed) and reconnects with exponential backoff.
   *
   * @param subscription - The authorization subscription to evaluate.
   * @returns An observable stream of authorization decisions.
   */
  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision> {
    const { secrets, ...safeForLog } = subscription;
    this.logger.debug(`Streaming subscription: ${JSON.stringify(safeForLog)}`);
    const indeterminate: AuthorizationDecision = { decision: 'INDETERMINATE' };
    return this.streamSse(this.decideUrl, JSON.stringify(subscription), (parsed) => {
      const validated = validateDecision(parsed, this.logger);
      this.logger.debug(`Streaming decision: ${JSON.stringify(validated)}`);
      return validated;
    }, (subscriber) => subscriber.next(indeterminate));
  }

  /**
   * Sends multiple authorization subscriptions to the PDP and returns a snapshot of all decisions.
   *
   * Returns an empty decisions map when the PDP is unreachable or returns an invalid response.
   * Secrets in nested subscriptions are sent to the PDP but never logged.
   *
   * @param subscription - A map of subscription IDs to authorization subscriptions.
   * @returns A snapshot mapping each subscription ID to its authorization decision.
   */
  async multiDecideAllOnce(
    subscription: MultiAuthorizationSubscription,
  ): Promise<MultiAuthorizationDecision> {
    this.logger.debug(`Requesting multi-decide-all-once: ${JSON.stringify(redactSecrets(subscription))}`);
    const raw = await this.fetchOnce(this.multiDecideAllOnceUrl, JSON.stringify(subscription));
    if (raw === null) return { decisions: {} };
    this.logger.debug(`Multi-decide-all-once result: ${JSON.stringify(raw)}`);
    return validateMultiDecision(raw, this.logger) ?? { decisions: {} };
  }

  /**
   * Opens a streaming SSE connection for multiple subscriptions, emitting individual decisions.
   *
   * Each emission is an {@link IdentifiableAuthorizationDecision} identifying which subscription
   * changed. Only the changed decision is emitted, not the full set. On connection loss,
   * reconnects with exponential backoff. Consecutive duplicate events are suppressed.
   *
   * @param subscription - A map of subscription IDs to authorization subscriptions.
   * @returns An observable stream of individual identifiable decisions.
   */
  multiDecide(
    subscription: MultiAuthorizationSubscription,
  ): Observable<IdentifiableAuthorizationDecision> {
    this.logger.debug(`Streaming multi-decide: ${JSON.stringify(redactSecrets(subscription))}`);
    return this.streamSse(this.multiDecideUrl, JSON.stringify(subscription), (parsed) => {
      const validated = validateIdentifiableDecision(parsed, this.logger);
      if (validated) this.logger.debug(`Multi-decide decision: ${JSON.stringify(validated)}`);
      return validated;
    }, (subscriber) => {
      for (const subscriptionId of Object.keys(subscription.subscriptions)) {
        subscriber.next({ subscriptionId, decision: { decision: 'INDETERMINATE' } });
      }
    });
  }

  /**
   * Opens a streaming SSE connection for multiple subscriptions, emitting complete snapshots.
   *
   * Each emission is a {@link MultiAuthorizationDecision} containing the current decision for
   * every subscription. A new snapshot is emitted whenever any individual decision changes.
   * On connection loss, reconnects with exponential backoff. Consecutive duplicate snapshots
   * are suppressed.
   *
   * @param subscription - A map of subscription IDs to authorization subscriptions.
   * @returns An observable stream of complete decision snapshots.
   */
  multiDecideAll(
    subscription: MultiAuthorizationSubscription,
  ): Observable<MultiAuthorizationDecision> {
    this.logger.debug(`Streaming multi-decide-all: ${JSON.stringify(redactSecrets(subscription))}`);
    return this.streamSse(this.multiDecideAllUrl, JSON.stringify(subscription), (parsed) => {
      const validated = validateMultiDecision(parsed, this.logger);
      if (validated) this.logger.debug(`Multi-decide-all decision: ${JSON.stringify(validated)}`);
      return validated;
    }, (subscriber) => {
      const decisions: Record<string, AuthorizationDecision> = {};
      for (const id of Object.keys(subscription.subscriptions)) {
        decisions[id] = { decision: 'INDETERMINATE' };
      }
      subscriber.next({ decisions });
    });
  }

  private async fetchOnce(url: string, body: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.authorizationHeader) {
        headers['Authorization'] = this.authorizationHeader;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        let responseBody = '';
        try {
          responseBody = await response.text();
        } catch {
          /* ignore unreadable body */
        }
        this.logger.error(
          `PDP returned HTTP ${response.status} (${response.statusText}) ` +
            `for ${url}` +
            (responseBody
              ? ` -- body: ${responseBody.length > MAX_LOG_BODY_LENGTH ? responseBody.substring(0, MAX_LOG_BODY_LENGTH) + '...' : responseBody}`
              : ''),
        );
        if (response.status === 401 || response.status === 403) {
          this.logger.error(
            'PDP authentication failed. Check token or username/secret configuration.',
          );
        }
        return null;
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(`PDP request to ${url} timed out after ${this.timeoutMs}ms`);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`PDP request to ${url} failed: ${msg}`);
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

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      if (this.authorizationHeader) {
        headers['Authorization'] = this.authorizationHeader;
      }

      fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }).then(async (response) => {
        clearTimeout(connectTimeout);

        if (!response.ok) {
          let responseBody = '';
          try {
            responseBody = await response.text();
          } catch {
            /* ignore unreadable body */
          }
          const statusMsg =
            `PDP returned HTTP ${response.status} (${response.statusText}) ` +
            `for ${url}` +
            (responseBody
              ? ` -- body: ${responseBody.length > MAX_LOG_BODY_LENGTH ? responseBody.substring(0, MAX_LOG_BODY_LENGTH) + '...' : responseBody}`
              : '');
          this.logger.error(statusMsg);
          if (response.status === 401 || response.status === 403) {
            this.logger.error(
              'PDP authentication failed. Check token or username/secret configuration. Retrying with backoff.',
            );
          }
          emitError(subscriber, new Error(`PDP returned HTTP ${response.status}`));
          return;
        }

        if (!response.body) {
          this.logger.error('PDP streaming response has no body');
          emitError(subscriber, new Error('PDP streaming response has no body'));
          return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            if (buffer.length > MAX_BUFFER_SIZE) {
              this.logger.error(
                `PDP streaming buffer exceeded ${MAX_BUFFER_SIZE} bytes. ` +
                'Aborting connection to prevent memory exhaustion.',
              );
              emitError(subscriber, new Error('PDP streaming buffer overflow'));
              return;
            }

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith(':') || trimmed === '') continue;
              const data = trimmed.startsWith('data:')
                ? trimmed.slice(5).trim()
                : trimmed;
              if (data === '') continue;
              try {
                const parsed = JSON.parse(data);
                const validated = validate(parsed);
                if (validated !== null) subscriber.next(validated);
              } catch (parseError) {
                this.logger.warn(`Failed to parse streaming data: ${data}`);
              }
            }
          }

          const trailing = buffer.trim();
          if (trailing !== '') {
            const data = trailing.startsWith('data:')
              ? trailing.slice(5).trim()
              : trailing;
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

          emitError(subscriber, new Error('PDP decision stream ended unexpectedly'));
        } catch (error) {
          if (controller.signal.aborted) return;
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`PDP streaming read failed: ${msg}`);
          emitError(subscriber, error instanceof Error ? error : new Error(String(error)));
        }
      }).catch((error) => {
        clearTimeout(connectTimeout);
        if (controller.signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') {
          this.logger.error(
            `PDP streaming connection to ${url} timed out after ${this.timeoutMs}ms`,
          );
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`PDP streaming request to ${url} failed: ${msg}`);
        }
        emitError(subscriber, error instanceof Error ? error : new Error(String(error)));
      });

      return () => {
        clearTimeout(connectTimeout);
        reader?.cancel().catch(() => {});
        controller.abort();
      };
    });

    return singleAttempt$.pipe(
      retry({
        count: this.maxRetries,
        delay: (_error, retryCount) => {
          const baseDelay = Math.min(
            this.retryBaseDelay * Math.pow(2, retryCount - 1),
            this.retryMaxDelay,
          );
          const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
          const message =
            `PDP streaming connection lost, reconnecting in ${delay}ms` +
            ` (attempt ${retryCount}${this.maxRetries === Infinity ? '' : `/${this.maxRetries}`})`;
          if (retryCount >= RETRY_ESCALATION_THRESHOLD) {
            this.logger.error(message);
          } else {
            this.logger.warn(message);
          }
          return timer(delay);
        },
      }),
      distinctUntilChanged(deepEqual),
    );
  }
}

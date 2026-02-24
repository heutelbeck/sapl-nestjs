import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable, distinctUntilChanged, retry, timer } from 'rxjs';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';
import { AuthorizationDecision, AuthorizationSubscription, Decision } from './types';

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

@Injectable()
export class PdpService {
  private readonly logger = new Logger(PdpService.name);
  private readonly timeoutMs: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly maxRetries: number;
  private readonly decideOnceUrl: string;
  private readonly decideUrl: string;

  constructor(
    @Inject(SAPL_MODULE_OPTIONS)
    private readonly options: SaplModuleOptions,
  ) {
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
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retryBaseDelay = options.streamingRetryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelay = options.streamingRetryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.maxRetries = options.streamingMaxRetries ?? Infinity;
    this.logger.log(`PDP configured at ${this.options.baseUrl}`);
  }

  async decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision> {
    const { secrets, ...safeForLog } = subscription;
    const body = JSON.stringify(subscription);

    this.logger.debug(`Requesting decision: ${JSON.stringify(safeForLog)}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.options.token) {
        headers['Authorization'] = `Bearer ${this.options.token}`;
      }

      const response = await fetch(
        this.decideOnceUrl,
        {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        let responseBody = '';
        try {
          responseBody = await response.text();
        } catch {
          /* ignore unreadable body */
        }
        this.logger.error(
          `PDP returned HTTP ${response.status} (${response.statusText}) ` +
            `for ${this.decideOnceUrl}` +
            (responseBody
              ? ` -- body: ${responseBody.length > MAX_LOG_BODY_LENGTH ? responseBody.substring(0, MAX_LOG_BODY_LENGTH) + '...' : responseBody}`
              : ''),
        );
        return { decision: 'INDETERMINATE' };
      }

      const decision = await response.json();
      this.logger.debug(`Decision: ${JSON.stringify(decision)}`);
      return validateDecision(decision, this.logger);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(
          `PDP request to ${this.decideOnceUrl} timed out after ${this.timeoutMs}ms`,
        );
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `PDP request to ${this.decideOnceUrl} failed: ${msg}`,
        );
      }
      return { decision: 'INDETERMINATE' };
    } finally {
      clearTimeout(timeout);
    }
  }

  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision> {
    const { secrets, ...safeForLog } = subscription;
    const body = JSON.stringify(subscription);

    this.logger.debug(`Streaming subscription: ${JSON.stringify(safeForLog)}`);

    const singleAttempt$ = new Observable<AuthorizationDecision>((subscriber) => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const connectTimeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
      };
      if (this.options.token) {
        headers['Authorization'] = `Bearer ${this.options.token}`;
      }

      fetch(this.decideUrl, {
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
          this.logger.error(
            `PDP returned HTTP ${response.status} (${response.statusText}) ` +
              `for ${this.decideUrl}` +
              (responseBody
                ? ` -- body: ${responseBody.length > MAX_LOG_BODY_LENGTH ? responseBody.substring(0, MAX_LOG_BODY_LENGTH) + '...' : responseBody}`
                : ''),
          );
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(new Error(`PDP returned HTTP ${response.status}`));
          return;
        }

        if (!response.body) {
          this.logger.error('PDP streaming response has no body');
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(new Error('PDP streaming response has no body'));
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
              subscriber.next({ decision: 'INDETERMINATE' });
              subscriber.error(new Error('PDP streaming buffer overflow'));
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
                const decision = JSON.parse(data);
                this.logger.debug(`Streaming decision: ${JSON.stringify(decision)}`);
                subscriber.next(validateDecision(decision, this.logger));
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
                const decision = JSON.parse(data);
                subscriber.next(validateDecision(decision, this.logger));
              } catch {
                /* ignore trailing partial data */
              }
            }
          }

          // PDP closed the stream -- fail closed and let retry reconnect
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(new Error('PDP decision stream ended unexpectedly'));
        } catch (error) {
          if (controller.signal.aborted) return;
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`PDP streaming read failed: ${msg}`);
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(error);
        }
      }).catch((error) => {
        clearTimeout(connectTimeout);
        if (controller.signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') {
          this.logger.error(
            `PDP streaming connection to ${this.decideUrl} timed out after ${this.timeoutMs}ms`,
          );
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `PDP streaming request to ${this.decideUrl} failed: ${msg}`,
          );
        }
        subscriber.next({ decision: 'INDETERMINATE' });
        subscriber.error(error);
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

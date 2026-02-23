import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable, distinctUntilChanged, retry, timer } from 'rxjs';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';
import { AuthorizationDecision, AuthorizationSubscription } from './types';

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_LOG_BODY_LENGTH = 500;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30000;

@Injectable()
export class PdpService {
  private readonly logger = new Logger(PdpService.name);
  private readonly timeoutMs: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly maxRetries: number;

  constructor(
    @Inject(SAPL_MODULE_OPTIONS)
    private readonly options: SaplModuleOptions,
  ) {
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
        `${this.options.baseUrl}/api/pdp/decide-once`,
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
            `for ${this.options.baseUrl}/api/pdp/decide-once` +
            (responseBody
              ? ` -- body: ${responseBody.length > MAX_LOG_BODY_LENGTH ? responseBody.substring(0, MAX_LOG_BODY_LENGTH) + '...' : responseBody}`
              : ''),
        );
        return { decision: 'INDETERMINATE' };
      }

      const decision = await response.json();
      this.logger.debug(`Decision: ${JSON.stringify(decision)}`);
      return decision;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.error(
          `PDP request to ${this.options.baseUrl}/api/pdp/decide-once timed out after ${this.timeoutMs}ms`,
        );
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `PDP request to ${this.options.baseUrl}/api/pdp/decide-once failed: ${msg}`,
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

      fetch(`${this.options.baseUrl}/api/pdp/decide`, {
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
              `for ${this.options.baseUrl}/api/pdp/decide` +
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
                subscriber.next(decision);
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
                subscriber.next(decision);
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
            `PDP streaming connection to ${this.options.baseUrl}/api/pdp/decide timed out after ${this.timeoutMs}ms`,
          );
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `PDP streaming request to ${this.options.baseUrl}/api/pdp/decide failed: ${msg}`,
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
          const delay = Math.min(
            this.retryBaseDelay * Math.pow(2, retryCount - 1),
            this.retryMaxDelay,
          );
          this.logger.warn(
            `PDP streaming connection lost, reconnecting in ${delay}ms` +
              ` (attempt ${retryCount}${this.maxRetries === Infinity ? '' : `/${this.maxRetries}`})`,
          );
          return timer(delay);
        },
      }),
      distinctUntilChanged(deepEqual),
    );
  }
}

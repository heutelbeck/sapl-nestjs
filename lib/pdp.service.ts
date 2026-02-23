import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable, distinctUntilChanged } from 'rxjs';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';

const DEFAULT_TIMEOUT_MS = 5000;

@Injectable()
export class PdpService {
  private readonly logger = new Logger(PdpService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(SAPL_MODULE_OPTIONS)
    private readonly options: SaplModuleOptions,
  ) {
    this.timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.logger.log(`PDP configured at ${this.options.baseUrl}`);
  }

  async decideOnce(subscription: Record<string, any>): Promise<any> {
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
            (responseBody ? ` -- body: ${responseBody}` : ''),
        );
        return { decision: 'INDETERMINATE' };
      }

      const decision = await response.json();
      this.logger.debug(`Decision: ${JSON.stringify(decision)}`);
      return decision;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `PDP request to ${this.options.baseUrl}/api/pdp/decide-once failed: ${msg}`,
      );
      return { decision: 'INDETERMINATE' };
    } finally {
      clearTimeout(timeout);
    }
  }

  decide(subscription: Record<string, any>): Observable<any> {
    const { secrets, ...safeForLog } = subscription;
    const body = JSON.stringify(subscription);
    const logger = this.logger;
    const baseUrl = this.options.baseUrl;
    const token = this.options.token;

    logger.debug(`Streaming subscription: ${JSON.stringify(safeForLog)}`);

    return new Observable((subscriber) => {
      const controller = new AbortController();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      fetch(`${baseUrl}/api/pdp/decide`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) {
          let responseBody = '';
          try {
            responseBody = await response.text();
          } catch {
            /* ignore unreadable body */
          }
          logger.error(
            `PDP returned HTTP ${response.status} (${response.statusText}) ` +
              `for ${baseUrl}/api/pdp/decide` +
              (responseBody ? ` -- body: ${responseBody}` : ''),
          );
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(new Error(`PDP returned HTTP ${response.status}`));
          return;
        }

        if (!response.body) {
          logger.error('PDP streaming response has no body');
          subscriber.next({ decision: 'INDETERMINATE' });
          subscriber.error(new Error('PDP streaming response has no body'));
          return;
        }

        const reader = response.body.getReader();
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
              if (trimmed.startsWith('data:')) {
                const data = trimmed.slice(5).trim();
                if (data === '') continue;
                try {
                  const decision = JSON.parse(data);
                  logger.debug(`Streaming decision: ${JSON.stringify(decision)}`);
                  subscriber.next(decision);
                } catch (parseError) {
                  logger.warn(`Failed to parse SSE data: ${data}`);
                }
              }
            }
          }

          if (buffer.trim().startsWith('data:')) {
            const data = buffer.trim().slice(5).trim();
            if (data !== '') {
              try {
                const decision = JSON.parse(data);
                subscriber.next(decision);
              } catch {
                /* ignore trailing partial data */
              }
            }
          }

          subscriber.complete();
        } catch (error) {
          if (controller.signal.aborted) return;
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`PDP streaming read failed: ${msg}`);
          subscriber.error(error);
        }
      }).catch((error) => {
        if (controller.signal.aborted) return;
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`PDP streaming request to ${baseUrl}/api/pdp/decide failed: ${msg}`);
        subscriber.next({ decision: 'INDETERMINATE' });
        subscriber.error(error);
      });

      return () => {
        controller.abort();
      };
    }).pipe(
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );
  }
}

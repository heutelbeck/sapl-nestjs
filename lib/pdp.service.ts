import { Inject, Injectable, Logger } from '@nestjs/common';
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
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';

@Injectable()
export class PdpService {
  private readonly logger = new Logger(PdpService.name);

  constructor(
    @Inject(SAPL_MODULE_OPTIONS)
    private readonly options: SaplModuleOptions,
  ) {
    this.logger.log(`PDP configured at ${this.options.baseUrl}`);
  }

  async decideOnce(subscription: Record<string, any>): Promise<any> {
    const body = JSON.stringify(subscription);

    this.logger.debug(`Requesting decision: ${body}`);

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
    }
  }
}

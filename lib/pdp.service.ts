import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';
import { HttpPdpClient } from './transport/HttpPdpClient';
import type { PdpClient } from './transport/PdpClient';
import { RsocketPdpClient } from './transport/RsocketPdpClient';
import type {
  AuthorizationDecision,
  AuthorizationSubscription,
  IdentifiableAuthorizationDecision,
  MultiAuthorizationDecision,
  MultiAuthorizationSubscription,
} from './types';

/**
 * NestJS-injectable façade over the configured transport. Delegates every
 * method to the underlying {@link PdpClient}; the choice between HTTP
 * (default) and RSocket transports is made at module configuration time
 * via {@link SaplModuleOptions.transport}.
 */
@Injectable()
export class PdpService implements OnModuleDestroy {
  private readonly logger = new Logger(PdpService.name);
  private readonly client: PdpClient;

  constructor(@Inject(SAPL_MODULE_OPTIONS) options: SaplModuleOptions) {
    this.client = buildClient(options);
    this.logger.log(
      `PdpService configured (transport=${options.transport ?? 'http'}, baseUrl=${options.baseUrl})`,
    );
  }

  decideOnce(subscription: AuthorizationSubscription): Promise<AuthorizationDecision> {
    return this.client.decideOnce(subscription);
  }

  decide(subscription: AuthorizationSubscription): Observable<AuthorizationDecision> {
    return this.client.decide(subscription);
  }

  multiDecide(subscription: MultiAuthorizationSubscription): Observable<IdentifiableAuthorizationDecision> {
    return this.client.multiDecide(subscription);
  }

  multiDecideAll(subscription: MultiAuthorizationSubscription): Observable<MultiAuthorizationDecision> {
    return this.client.multiDecideAll(subscription);
  }

  multiDecideAllOnce(subscription: MultiAuthorizationSubscription): Promise<MultiAuthorizationDecision> {
    return this.client.multiDecideAllOnce(subscription);
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('PdpService closing transport on module destroy');
    await this.client.close();
  }
}

function buildClient(options: SaplModuleOptions): PdpClient {
  const transport = options.transport ?? 'http';
  switch (transport) {
    case 'http':
      return new HttpPdpClient({
        baseUrl: options.baseUrl,
        token: options.token,
        username: options.username,
        secret: options.secret,
        timeout: options.timeout,
        streamingMaxRetries: options.streamingMaxRetries,
        streamingRetryBaseDelay: options.streamingRetryBaseDelay,
        streamingRetryMaxDelay: options.streamingRetryMaxDelay,
        tls: options.tls,
      });
    case 'rsocket':
      return new RsocketPdpClient({
        host: options.rsocketHost ?? new URL(options.baseUrl).hostname,
        port: options.rsocketPort ?? 7000,
        basic:
          options.username && options.secret
            ? { username: options.username, password: options.secret }
            : undefined,
        apiKey: options.token,
      });
  }
}

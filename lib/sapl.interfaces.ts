import { ModuleMetadata } from '@nestjs/common';
import { ClsModuleOptions } from 'nestjs-cls';

export interface SaplModuleOptions {
  /** Base URL of the SAPL PDP server (e.g., 'https://localhost:8443') */
  baseUrl: string;
  /** Bearer token (API key or JWT) for PDP authentication. Mutually exclusive with username/secret. */
  token?: string;
  /** Username for HTTP Basic Auth. Must be used together with `secret`. Mutually exclusive with `token`. */
  username?: string;
  /** Password for HTTP Basic Auth. Must be used together with `username`. Mutually exclusive with `token`. */
  secret?: string;
  /** Timeout in milliseconds for PDP HTTP requests (default: 5000) */
  timeout?: number;
  /** Maximum reconnection attempts for streaming subscriptions (default: unlimited) */
  streamingMaxRetries?: number;
  /** Initial delay in ms before first streaming reconnection (default: 1000) */
  streamingRetryBaseDelay?: number;
  /** Maximum backoff delay in ms for streaming reconnection (default: 30000) */
  streamingRetryMaxDelay?: number;
  /** Set to true to allow unencrypted HTTP connections to the PDP. NOT RECOMMENDED for production. */
  allowInsecureConnections?: boolean;
  /** Options merged into ClsModule.forRoot(). Default: { global: true, middleware: { mount: true } } */
  cls?: Partial<ClsModuleOptions>;
  /**
   * When true, `@PreEnforce` and `@PostEnforce` wrap method execution and
   * constraint handling in a single database transaction via
   * `@nestjs-cls/transactional`'s `TransactionHost.withTransaction()`.
   * Any constraint failure or DENY decision triggers a rollback.
   *
   * Requires `@nestjs-cls/transactional` and `ClsPluginTransactional` to be
   * installed and registered in your `ClsModule` configuration.
   */
  transactional?: boolean;
}

export interface SaplModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<SaplModuleOptions> | SaplModuleOptions;
  inject?: any[];
}

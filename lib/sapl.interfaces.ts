import { ModuleMetadata } from '@nestjs/common';
import { ClsModuleOptions } from 'nestjs-cls';
import type { TlsConfig } from './transport/TlsConfig';
import type { OAuth2TokenProviderOptions } from './transport/auth/OAuth2TokenProvider';

export interface SaplModuleOptions {
  /**
   * Which transport the PDP client uses. Defaults to `'http'` for backward
   * compatibility with 1.x. Set to `'rsocket'` to opt into the high-throughput
   * binary protocol against a SAPL Node listening on its RSocket port.
   */
  transport?: 'http' | 'rsocket';
  /** Base URL of the SAPL PDP server (e.g., 'https://localhost:8443') for the HTTP transport. */
  baseUrl: string;
  /** RSocket host. Defaults to the hostname extracted from `baseUrl`. Only used when `transport: 'rsocket'`. */
  rsocketHost?: string;
  /** RSocket TCP port. Defaults to 7000. Only used when `transport: 'rsocket'`. */
  rsocketPort?: number;
  /** Bearer token (API key or JWT) for PDP authentication. Mutually exclusive with username/secret. */
  token?: string;
  /** Username for HTTP Basic Auth. Must be used together with `secret`. Mutually exclusive with `token`. */
  username?: string;
  /** Password for HTTP Basic Auth. Must be used together with `username`. Mutually exclusive with `token`. */
  secret?: string;
  /**
   * OAuth2 client_credentials configuration. When set, the client obtains
   * bearer tokens from the configured OIDC issuer with automatic refresh,
   * instead of a static `token` or `username`/`secret`. Mutually exclusive
   * with `token` and `username`/`secret`. Applies to both transports.
   */
  oauth2?: OAuth2TokenProviderOptions;
  /** Timeout in milliseconds for PDP HTTP requests (default: 5000) */
  timeout?: number;
  /** Maximum reconnection attempts for streaming subscriptions (default: unlimited) */
  streamingMaxRetries?: number;
  /** Initial delay in ms before first streaming reconnection (default: 1000) */
  streamingRetryBaseDelay?: number;
  /** Maximum backoff delay in ms for streaming reconnection (default: 30000) */
  streamingRetryMaxDelay?: number;
  /**
   * Optional TLS configuration for the HTTPS connection to the PDP.
   * Without this the client uses Node's default trust store. Plain
   * HTTP to a non-loopback host is refused at client construction.
   */
  tls?: TlsConfig;
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

export interface SaplModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => Promise<SaplModuleOptions> | SaplModuleOptions;
  inject?: any[];
}

import { Logger } from '@nestjs/common';
import { ClientSecretPost, Configuration, clientCredentialsGrant, discovery } from 'openid-client';

const ERROR_MISSING_ACCESS_TOKEN = 'OAuth2 client_credentials response did not include an access_token.';
const REFRESH_GUARD_SECONDS = 30;

export interface OAuth2TokenProviderOptions {
  /** Discovery URL of the OAuth2 / OIDC issuer (e.g., https://issuer/realms/sapl). */
  readonly issuerUrl: string;
  /** OAuth2 client id (typically the SAPL Node user id). */
  readonly clientId: string;
  /** OAuth2 client secret. */
  readonly clientSecret: string;
  /** Optional space-separated list of scopes to request. */
  readonly scope?: string;
  /**
   * Clock-skew tolerance in seconds (default 30) applied when deciding
   * whether to refresh a cached token before its expiry.
   */
  readonly refreshGuardSeconds?: number;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * Acquires and caches OAuth2 access tokens via the client_credentials
 * grant. Tokens are reused until their expiry is within
 * `refreshGuardSeconds` of now; the next call then triggers a fresh
 * grant. Concurrent callers share a single in-flight refresh.
 */
export class OAuth2TokenProvider {
  private readonly logger = new Logger(OAuth2TokenProvider.name);
  private readonly refreshGuardSeconds: number;
  private cached: CachedToken | null = null;
  private configurationPromise: Promise<Configuration> | null = null;
  private pendingRefresh: Promise<string> | null = null;

  constructor(private readonly options: OAuth2TokenProviderOptions) {
    this.refreshGuardSeconds = options.refreshGuardSeconds ?? REFRESH_GUARD_SECONDS;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached !== null && this.cached.expiresAt > Date.now() + this.refreshGuardSeconds * 1000) {
      return this.cached.accessToken;
    }
    if (this.pendingRefresh !== null) {
      return this.pendingRefresh;
    }
    this.pendingRefresh = this.refreshOnce().finally(() => {
      this.pendingRefresh = null;
    });
    return this.pendingRefresh;
  }

  private async refreshOnce(): Promise<string> {
    const configuration = await this.getConfiguration();
    const parameters: Record<string, string> = {};
    if (this.options.scope) {
      parameters.scope = this.options.scope;
    }
    const response = await clientCredentialsGrant(configuration, parameters);
    if (!response.access_token) {
      throw new Error(ERROR_MISSING_ACCESS_TOKEN);
    }
    const lifetimeSeconds = response.expires_in ?? 60;
    this.cached = {
      accessToken: response.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1000,
    };
    this.logger.debug(`OAuth2 access token acquired, valid for ${lifetimeSeconds}s`);
    return this.cached.accessToken;
  }

  /** Forces a fresh token on the next call. */
  invalidate(): void {
    this.cached = null;
  }

  private getConfiguration(): Promise<Configuration> {
    if (this.configurationPromise === null) {
      this.configurationPromise = discovery(
        new URL(this.options.issuerUrl),
        this.options.clientId,
        this.options.clientSecret,
        ClientSecretPost(this.options.clientSecret),
      );
    }
    return this.configurationPromise;
  }
}

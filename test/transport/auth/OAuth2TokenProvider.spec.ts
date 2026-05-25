import { OAuth2TokenProvider } from '../../../lib/transport/auth/OAuth2TokenProvider';

jest.mock('openid-client', () => ({
  discovery: jest.fn(),
  clientCredentialsGrant: jest.fn(),
  ClientSecretPost: (secret: string) => secret,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const openid = require('openid-client');

const options = {
  issuerUrl: 'https://issuer.example/realms/sapl',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

describe('OAuth2TokenProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    openid.discovery.mockResolvedValue({});
  });

  test('whenIssuerSucceedsThenTokenIsCached', async () => {
    openid.clientCredentialsGrant.mockResolvedValue({ access_token: 'tok-1', expires_in: 3600 });
    const provider = new OAuth2TokenProvider(options);

    const first = await provider.getAccessToken();
    const second = await provider.getAccessToken();

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(openid.clientCredentialsGrant).toHaveBeenCalledTimes(1);
  });

  test('whenConcurrentCallersDuringRefreshThenSingleInFlightRequest', async () => {
    let resolveGrant: (v: unknown) => void = () => undefined;
    openid.clientCredentialsGrant.mockReturnValue(
      new Promise((resolve) => {
        resolveGrant = resolve;
      }),
    );
    const provider = new OAuth2TokenProvider(options);

    const promiseA = provider.getAccessToken();
    const promiseB = provider.getAccessToken();
    resolveGrant({ access_token: 'tok-shared', expires_in: 60 });

    await expect(promiseA).resolves.toBe('tok-shared');
    await expect(promiseB).resolves.toBe('tok-shared');
    expect(openid.clientCredentialsGrant).toHaveBeenCalledTimes(1);
  });

  test('whenIssuerFailsThenErrorPropagatesAndNextCallRetries', async () => {
    openid.clientCredentialsGrant
      .mockRejectedValueOnce(new Error('idp down'))
      .mockResolvedValueOnce({ access_token: 'tok-after-recovery', expires_in: 60 });
    const provider = new OAuth2TokenProvider(options);

    await expect(provider.getAccessToken()).rejects.toThrow('idp down');
    await expect(provider.getAccessToken()).resolves.toBe('tok-after-recovery');
    expect(openid.clientCredentialsGrant).toHaveBeenCalledTimes(2);
  });

  test('whenInvalidateCalledThenNextCallRefreshes', async () => {
    openid.clientCredentialsGrant
      .mockResolvedValueOnce({ access_token: 'tok-a', expires_in: 3600 })
      .mockResolvedValueOnce({ access_token: 'tok-b', expires_in: 3600 });
    const provider = new OAuth2TokenProvider(options);

    expect(await provider.getAccessToken()).toBe('tok-a');
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe('tok-b');
  });
});

import { GenericContainer, StartedNetwork, StartedTestContainer, Wait } from 'testcontainers';

const OAUTH_PORT = 8080;
const STARTUP_TIMEOUT_MS = 60_000;

const DEFAULT_IMAGE = 'ghcr.io/navikt/mock-oauth2-server:2.1.0';

export interface MockOauth2ServerOptions {
  /** Network shared with the SAPL Node so the Node can resolve the issuer hostname. */
  readonly network: StartedNetwork;
  /** Network alias the issuer is reachable under (default: `auth-host`). */
  readonly alias?: string;
  /** Realm / issuer id segment (default: `default`). */
  readonly issuerId?: string;
}

export interface StartedMockOauth2Server {
  readonly container: StartedTestContainer;
  /** Issuer URI as the SAPL Node sees it (uses the container alias). */
  readonly issuerUri: string;
  /** Issuer URI as host code sees it (uses the mapped port on localhost). */
  readonly hostIssuerUri: string;
  /** Token endpoint URL from the host's perspective. */
  readonly tokenEndpoint: string;
  stop(): Promise<void>;
}

/**
 * Spins up a Navikt mock-oauth2-server: a lightweight JWT issuer that
 * accepts any client_credentials request and signs the response with a
 * generated key, exposing the matching JWKS. Mirrors the choice the
 * engine-side `RemoteHttpDecisionPointServerIT` made; cheaper than a
 * full Keycloak realm and produces equivalent JWT validation surface
 * on the SAPL Node side.
 */
export async function startMockOauth2Server(
  options: MockOauth2ServerOptions,
): Promise<StartedMockOauth2Server> {
  const alias = options.alias ?? 'auth-host';
  const issuerId = options.issuerId ?? 'default';
  const issuerUri = `http://${alias}:${OAUTH_PORT}/${issuerId}`;
  // Pin the iss claim so minted tokens always carry the network-alias issuer
  // the SAPL Node validates against, regardless of how the mock is reached.
  // Host code can then fetch a token over the mapped port with a plain request,
  // no Host-header spoofing required.
  const jsonConfig = JSON.stringify({
    interactiveLogin: false,
    tokenCallbacks: [
      {
        issuerId,
        requestMappings: [
          {
            requestParam: 'grant_type',
            match: 'client_credentials',
            claims: { sub: 'sapl-client', iss: issuerUri },
          },
        ],
      },
    ],
  });

  const container = await new GenericContainer(DEFAULT_IMAGE)
    .withNetwork(options.network)
    .withNetworkAliases(alias)
    .withExposedPorts(OAUTH_PORT)
    .withEnvironment({ JSON_CONFIG: jsonConfig, MOCK_OAUTH2_SERVER_HOSTNAME: alias })
    .withWaitStrategy(
      Wait.forHttp(`/${issuerId}/.well-known/openid-configuration`, OAUTH_PORT).forStatusCode(200),
    )
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  const host = container.getHost();
  const mapped = container.getMappedPort(OAUTH_PORT);
  return {
    container,
    issuerUri,
    hostIssuerUri: `http://${host}:${mapped}/${issuerId}`,
    tokenEndpoint: `http://${host}:${mapped}/${issuerId}/token`,
    async stop() {
      await container.stop();
    },
  };
}

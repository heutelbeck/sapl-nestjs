// TEST-ONLY HELPERS.
// Do not copy any defaults below (allowNoAuth=true, mounted policies, etc.)
// into production fixtures. The container is configured for fast IT bring-up,
// not for any environment that is reachable beyond the local docker network.
import { GenericContainer, StartedNetwork, StartedTestContainer, Wait } from 'testcontainers';
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const RSOCKET_PORT = 7000;
const READY_LOG_PATTERN = /SAPL Node ready/;
const STARTUP_TIMEOUT_MS = 120_000;

const TLS_BUNDLE_NAME = 'saplbundle';
const TLS_FIXTURE_DIR = resolve(__dirname, 'fixtures', 'tls');

const DEFAULT_IMAGE = 'ghcr.io/heutelbeck/sapl-node:4.1.0-SNAPSHOT';
const READY_PROBE_TIMEOUT_MS = 30_000;
const READY_PROBE_BODY = '{"subject":"_","action":"_","resource":"_"}';

/**
 * Waits until the node answers an HTTP decision request, mirroring the readiness
 * probe the other PEP integration suites use. The "SAPL Node ready" log marks
 * process startup, not decision-readiness; without this a cold PDP can make the
 * first multi-decision snapshot time out.
 */
async function waitUntilDecisionReady(httpUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(`${httpUrl}/api/pdp/decide-once`);
  const requestFn = (url.protocol === 'https:' ? httpsRequest : httpRequest) as typeof httpsRequest;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const responded = await new Promise<boolean>((resolveProbe) => {
      const req = requestFn(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          rejectUnauthorized: false,
          timeout: 2_000,
        },
        (res) => {
          res.resume();
          resolveProbe(true);
        },
      );
      req.on('error', () => resolveProbe(false));
      req.on('timeout', () => {
        req.destroy();
        resolveProbe(false);
      });
      req.end(READY_PROBE_BODY);
    });
    if (responded) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`SAPL Node did not become decision-ready within ${timeoutMs}ms.`);
}

/**
 * Test policies copied into the container at `/pdp/data/policies/`. A
 * single permit-all policy lets the IT focus on transport, codec and
 * auth concerns rather than policy authoring.
 */
const PERMIT_ALL_POLICY = `policy "permit-all"
permit`;

const DEFAULT_POLICIES: Readonly<Record<string, string>> = { 'permit-all.sapl': PERMIT_ALL_POLICY };

const DEFAULT_PDP_CONFIG = {
  algorithm: { votingMode: 'PRIORITY_PERMIT', defaultDecision: 'DENY', errorHandling: 'ABSTAIN' },
  variables: {},
};

export interface SaplNodeContainerOptions {
  /**
   * Override the image tag. Defaults to the env var SAPL_NODE_IMAGE or
   * `ghcr.io/heutelbeck/sapl-node:4.1.0-SNAPSHOT`. Use the env var when
   * targeting a pre-release published image.
   */
  readonly image?: string;
  /** Allow unauthenticated requests. Defaults to true for transport ITs. */
  readonly allowNoAuth?: boolean;
  /** Allow Basic Auth (with users from the `users` array). */
  readonly allowBasicAuth?: boolean;
  /** Allow API-key auth (with users from the `users` array). */
  readonly allowApiKeyAuth?: boolean;
  /** Allow OAuth2 JWT auth. Requires `oauth2IssuerUri`. */
  readonly allowOauth2Auth?: boolean;
  /** Issuer URI the SAPL Node uses to fetch JWKS and validate JWTs. */
  readonly oauth2IssuerUri?: string;
  /** Shared docker network (so the SAPL Node can resolve the issuer hostname). */
  readonly network?: StartedNetwork;
  /** Per-user credentials. */
  readonly users?: ReadonlyArray<UserEntry>;
  /**
   * Enable TLS on both HTTPS (8443) and RSocket (7000) using the test
   * fixture cert pair under `test/integration/fixtures/tls/`. When true,
   * the container exposes 8443 instead of 8080 and the RSocket port
   * speaks TLS. Use `caPemPath` on the returned object to feed the
   * trust anchor to the client.
   */
  readonly tls?: boolean;
  /**
   * Override the policy bundle. Keys are policy file names (ending in
   * `.sapl`), values are the SAPL source. Defaults to a single
   * permit-all policy. Provide content-dependent policies here to test
   * that subscription fields actually reach the node over the wire.
   */
  readonly policies?: Readonly<Record<string, string>>;
  /**
   * Override the `pdp.json` combining-algorithm configuration. Defaults
   * to `PRIORITY_PERMIT` / `DENY` / `ABSTAIN`. Use `defaultDecision:
   * 'ABSTAIN'` to get `NOT_APPLICABLE` when no policy matches.
   */
  readonly pdpConfig?: Record<string, unknown>;
}

export interface UserEntry {
  readonly id: string;
  readonly pdpId?: string;
  readonly basic?: { readonly username: string; readonly secret: string };
  readonly apiKey?: string;
  readonly apiKeyId?: string;
}

export interface StartedSaplNode {
  readonly container: StartedTestContainer;
  /** HTTP or HTTPS URL depending on the `tls` option. */
  readonly httpUrl: string;
  readonly rsocketHost: string;
  readonly rsocketPort: number;
  /** Path to the CA PEM file when `tls: true`, else null. */
  readonly caPemPath: string | null;
  stop(): Promise<void>;
}

/**
 * Spins up a fresh SAPL Node container with a permit-all policy bundle.
 * The default config exposes HTTP on a host-mapped port and RSocket on
 * another, both routed to a single Node process. Use this helper for
 * round-trip integration tests against the real PDP.
 *
 * Caller is responsible for `stop()` in `afterAll`.
 */
export async function startSaplNode(options: SaplNodeContainerOptions = {}): Promise<StartedSaplNode> {
  const image = options.image ?? process.env.SAPL_NODE_IMAGE ?? DEFAULT_IMAGE;
  const tlsEnabled = options.tls === true;
  const dataDir = mkdtempSync(join(tmpdir(), 'sapl-it-data-'));
  chmodSync(dataDir, 0o755);
  const policies = options.policies ?? DEFAULT_POLICIES;
  for (const [fileName, source] of Object.entries(policies)) {
    writeFileSync(join(dataDir, fileName), source);
    chmodSync(join(dataDir, fileName), 0o644);
  }
  const pdpConfigJson = JSON.stringify(options.pdpConfig ?? DEFAULT_PDP_CONFIG, null, 2);
  writeFileSync(join(dataDir, 'pdp.json'), pdpConfigJson);
  chmodSync(join(dataDir, 'pdp.json'), 0o644);
  if (tlsEnabled) {
    copyFileSync(join(TLS_FIXTURE_DIR, 'server.pem'), join(dataDir, 'server.pem'));
    copyFileSync(join(TLS_FIXTURE_DIR, 'server.key'), join(dataDir, 'server.key'));
    chmodSync(join(dataDir, 'server.pem'), 0o644);
    chmodSync(join(dataDir, 'server.key'), 0o644);
  }

  const env: Record<string, string> = {};
  env['IO_SAPL_PDP_EMBEDDED_PDPCONFIGTYPE'] = 'DIRECTORY';
  env['IO_SAPL_PDP_EMBEDDED_CONFIGPATH'] = '/pdp/data';
  env['IO_SAPL_PDP_EMBEDDED_POLICIESPATH'] = '/pdp/data';
  env['IO_SAPL_NODE_ALLOWNOAUTH'] = String(options.allowNoAuth ?? true);
  env['IO_SAPL_NODE_ALLOWBASICAUTH'] = String(options.allowBasicAuth ?? false);
  env['IO_SAPL_NODE_ALLOWAPIKEYAUTH'] = String(options.allowApiKeyAuth ?? false);
  env['IO_SAPL_NODE_ALLOWOAUTH2AUTH'] = String(options.allowOauth2Auth ?? false);
  if (options.oauth2IssuerUri) {
    env['SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUERURI'] = options.oauth2IssuerUri;
  }
  if (tlsEnabled) {
    env[`SPRING_SSL_BUNDLE_PEM_${TLS_BUNDLE_NAME.toUpperCase()}_KEYSTORE_CERTIFICATE`] =
      '/pdp/data/server.pem';
    env[`SPRING_SSL_BUNDLE_PEM_${TLS_BUNDLE_NAME.toUpperCase()}_KEYSTORE_PRIVATEKEY`] =
      '/pdp/data/server.key';
    env['SERVER_SSL_BUNDLE'] = TLS_BUNDLE_NAME;
    env['SERVER_SSL_ENABLED'] = 'true';
    env['SERVER_PORT'] = String(HTTPS_PORT);
    env['SAPL_PDP_RSOCKET_SSL_BUNDLE'] = TLS_BUNDLE_NAME;
  }
  for (const [index, user] of (options.users ?? []).entries()) {
    const prefix = `IO_SAPL_NODE_USERS_${index}_`;
    env[`${prefix}ID`] = user.id;
    if (user.pdpId) env[`${prefix}PDPID`] = user.pdpId;
    if (user.basic) {
      env[`${prefix}BASIC_USERNAME`] = user.basic.username;
      env[`${prefix}BASIC_SECRET`] = user.basic.secret;
    }
    if (user.apiKey) env[`${prefix}APIKEY`] = user.apiKey;
    if (user.apiKeyId) env[`${prefix}APIKEYID`] = user.apiKeyId;
  }

  const exposedHttpPort = tlsEnabled ? HTTPS_PORT : HTTP_PORT;
  let builder = new GenericContainer(image)
    .withExposedPorts(exposedHttpPort, RSOCKET_PORT)
    .withBindMounts([{ source: dataDir, target: '/pdp/data', mode: 'ro' }])
    .withEnvironment(env)
    .withWaitStrategy(Wait.forLogMessage(READY_LOG_PATTERN))
    .withStartupTimeout(STARTUP_TIMEOUT_MS);
  if (options.network) {
    builder = builder.withNetwork(options.network).withNetworkAliases('sapl-node');
  }
  const container = await builder.start();

  const mappedHttp = container.getMappedPort(exposedHttpPort);
  const mappedRsocket = container.getMappedPort(RSOCKET_PORT);
  const host = container.getHost();
  const scheme = tlsEnabled ? 'https' : 'http';
  const httpUrl = `${scheme}://${host}:${mappedHttp}`;

  await waitUntilDecisionReady(httpUrl, READY_PROBE_TIMEOUT_MS);

  return {
    container,
    httpUrl,
    rsocketHost: host,
    rsocketPort: mappedRsocket,
    caPemPath: tlsEnabled ? join(TLS_FIXTURE_DIR, 'ca.pem') : null,
    async stop() {
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

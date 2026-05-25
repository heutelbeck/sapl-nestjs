// TEST CODE ONLY.
// The `node:http` POST + Host-header spoof pattern below works around
// a quirk of mock-oauth2-server in the docker testcontainer (it derives
// the `iss` claim from the request Host header AND Node's undici fetch
// silently drops Host overrides). Production code MUST NOT copy this
// pattern -- token endpoints must always be HTTPS, and the Host header
// must not be spoofed against real issuers.
import { request } from 'node:http';
import { Network, type StartedNetwork } from 'testcontainers';
import { HttpPdpClient } from '../../lib/transport/HttpPdpClient';
import { RsocketPdpClient } from '../../lib/transport/RsocketPdpClient';
import { startSaplNode, type StartedSaplNode } from './sapl-node-container';
import { startMockOauth2Server, type StartedMockOauth2Server } from './mock-oauth2-server';

const CLIENT_ID = 'sapl-client';
const CLIENT_SECRET = 'unused-by-mock-oauth2-server-but-required-by-token-grant';

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

function fetchAccessToken(tokenEndpoint: string, issuerHostHeader: string): Promise<string> {
  const url = new URL(tokenEndpoint);
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;
  // mock-oauth2-server derives the iss claim from the request Host
  // header. Node's fetch (undici) silently drops Host overrides, so we
  // use node:http which honours it. The JWT's iss must match the
  // resource-server's configured issuer URI for validation to pass.
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Host: issuerHostHeader,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Token endpoint returned HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TokenResponse;
          resolve(payload.access_token);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('OAuth2 transport (integration, requires docker + sapl-node + mock-oauth2-server)', () => {
  let network: StartedNetwork;
  let oauth: StartedMockOauth2Server;
  let node: StartedSaplNode;

  beforeAll(async () => {
    network = await new Network().start();
    oauth = await startMockOauth2Server({ network });
    node = await startSaplNode({
      network,
      allowNoAuth: false,
      allowOauth2Auth: true,
      oauth2IssuerUri: oauth.issuerUri,
    });
  }, 240_000);

  afterAll(async () => {
    await node.stop();
    await oauth.stop();
    await network.stop();
  }, 60_000);

  describe('HttpPdpClient via OAuth2 bearer token', () => {
    test('whenDecideOnceCalledWithValidJwtThenPermitReturned', async () => {
      const token = await fetchAccessToken(oauth.tokenEndpoint, 'auth-host:8080');
      const client = new HttpPdpClient({
        baseUrl: node.httpUrl,
        token,
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('PERMIT');
      } finally {
        await client.close();
      }
    });
  });

  describe('RsocketPdpClient via OAuth2 bearer token', () => {
    test('whenDecideOnceCalledOverRsocketWithValidJwtThenPermitReturned', async () => {
      const token = await fetchAccessToken(oauth.tokenEndpoint, 'auth-host:8080');
      const client = new RsocketPdpClient({
        host: node.rsocketHost,
        port: node.rsocketPort,
        apiKey: token,
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('PERMIT');
      } finally {
        await client.close();
      }
    });
  });
});

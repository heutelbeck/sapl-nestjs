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

async function fetchAccessToken(tokenEndpoint: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token endpoint returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as TokenResponse;
  return payload.access_token;
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
      const token = await fetchAccessToken(oauth.tokenEndpoint);
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
      const token = await fetchAccessToken(oauth.tokenEndpoint);
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

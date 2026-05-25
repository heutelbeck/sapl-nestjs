import { firstValueFrom, take, toArray } from 'rxjs';
import { RsocketPdpClient } from '../../lib/transport/RsocketPdpClient';
import { startSaplNode, type StartedSaplNode } from './sapl-node-container';

describe('RsocketPdpClient (integration, requires docker + local sapl-node image)', () => {
  describe('no-auth transport', () => {
    let node: StartedSaplNode;
    let client: RsocketPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({ allowNoAuth: true });
      client = new RsocketPdpClient({ host: node.rsocketHost, port: node.rsocketPort });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenDecideOnceCalledOverRsocketThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });

    test('whenDecideStreamSubscribedOverRsocketThenAtLeastOnePermitArrives', async () => {
      const decisions = await firstValueFrom(
        client.decide({ subject: 'alice', action: 'read', resource: 'doc-1' }).pipe(take(1), toArray()),
      );

      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision).toBe('PERMIT');
    });

    test('whenMultiDecideAllOnceCalledOverRsocketThenSnapshotContainsBothSubscriptions', async () => {
      const snapshot = await client.multiDecideAllOnce({
        subscriptions: {
          a: { subject: 'alice', action: 'read', resource: 'doc-1' },
          b: { subject: 'alice', action: 'write', resource: 'doc-2' },
        },
      });

      expect(snapshot.decisions.a.decision).toBe('PERMIT');
      expect(snapshot.decisions.b.decision).toBe('PERMIT');
    });
  });

  describe('api-key auth transport', () => {
    const wireToken = 'sapl_7A7ByyQd6U_5nTv3KXXLPiZ8JzHQywF9gww2v0iuA3j';
    const encodedApiKey =
      '$argon2id$v=19$m=16384,t=2,p=1$FttHTp38SkUUzUA4cA5Epg$QjzIAdvmNGP0auVlkCDpjrgr2LHeM5ul0BYLr7QKwBM';
    let node: StartedSaplNode;
    let client: RsocketPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({
        allowNoAuth: false,
        allowApiKeyAuth: true,
        users: [{ id: 'it-apikey-client', apiKey: encodedApiKey }],
      });
      client = new RsocketPdpClient({
        host: node.rsocketHost,
        port: node.rsocketPort,
        apiKey: wireToken,
      });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenDecideOnceCalledOverRsocketWithValidApiKeyThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });
  });
});

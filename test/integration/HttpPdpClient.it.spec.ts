import { firstValueFrom, take, toArray } from 'rxjs';
import { HttpPdpClient } from '../../lib/transport/HttpPdpClient';
import { startSaplNode, type StartedSaplNode } from './sapl-node-container';

describe('HttpPdpClient (integration, requires docker + local sapl-node image)', () => {
  describe('no-auth transport', () => {
    let node: StartedSaplNode;
    let client: HttpPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({ allowNoAuth: true });
      client = new HttpPdpClient({ baseUrl: node.httpUrl });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenDecideOnceCalledAgainstPermitAllPolicyThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });

    test('whenDecideStreamSubscribedThenAtLeastOnePermitDecisionArrives', async () => {
      const decisions = await firstValueFrom(
        client.decide({ subject: 'alice', action: 'read', resource: 'doc-1' }).pipe(take(1), toArray()),
      );

      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision).toBe('PERMIT');
    });

    test('whenMultiDecideAllOnceCalledThenSnapshotContainsBothSubscriptions', async () => {
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

  describe('basic auth transport', () => {
    // Reuse the precomputed Argon2id hash from the api-key fixture. Argon2
    // is a hash of the literal candidate string, so any auth method that
    // hashes user-supplied credentials accepts the original plaintext when
    // the stored hash matches.
    const password = 'sapl_7A7ByyQd6U_5nTv3KXXLPiZ8JzHQywF9gww2v0iuA3j';
    const encodedSecret =
      '$argon2id$v=19$m=16384,t=2,p=1$FttHTp38SkUUzUA4cA5Epg$QjzIAdvmNGP0auVlkCDpjrgr2LHeM5ul0BYLr7QKwBM';
    let node: StartedSaplNode;
    let client: HttpPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({
        allowNoAuth: false,
        allowBasicAuth: true,
        users: [{ id: 'it-basic-client', basic: { username: 'tester', secret: encodedSecret } }],
      });
      client = new HttpPdpClient({
        baseUrl: node.httpUrl,
        username: 'tester',
        secret: password,
      });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenDecideOnceCalledWithValidBasicCredentialsThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });

    test('whenDecideOnceCalledWithWrongPasswordThenIndeterminateReturned', async () => {
      const wrong = new HttpPdpClient({
        baseUrl: node.httpUrl,
        username: 'tester',
        secret: 'wrong-password',
      });
      try {
        const decision = await wrong.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('INDETERMINATE');
      } finally {
        await wrong.close();
      }
    });
  });

  describe('api-key auth transport', () => {
    // Precomputed plaintext + Argon2id hash pair. The wire token is the
    // plaintext form `sapl_<id>_<secret>`; the server stores the hash.
    // Pair reused verbatim from the engine-side IT to avoid an argon2
    // npm dependency just to encode test fixtures.
    const wireToken = 'sapl_7A7ByyQd6U_5nTv3KXXLPiZ8JzHQywF9gww2v0iuA3j';
    const encodedApiKey =
      '$argon2id$v=19$m=16384,t=2,p=1$FttHTp38SkUUzUA4cA5Epg$QjzIAdvmNGP0auVlkCDpjrgr2LHeM5ul0BYLr7QKwBM';
    let node: StartedSaplNode;
    let client: HttpPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({
        allowNoAuth: false,
        allowApiKeyAuth: true,
        users: [{ id: 'it-apikey-client', apiKey: encodedApiKey }],
      });
      client = new HttpPdpClient({
        baseUrl: node.httpUrl,
        token: wireToken,
      });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenDecideOnceCalledWithValidApiKeyThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });

    test('whenDecideOnceCalledWithoutCredentialsThenIndeterminateReturnedFailClosed', async () => {
      const unauthed = new HttpPdpClient({ baseUrl: node.httpUrl });
      try {
        const decision = await unauthed.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('INDETERMINATE');
      } finally {
        await unauthed.close();
      }
    });
  });
});

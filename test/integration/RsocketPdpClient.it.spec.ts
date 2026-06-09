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

  // Content-dependent policies prove that subject/action/resource actually
  // travel over the wire. A wire-codec bug that dropped these fields would
  // leave the subscription all-undefined: the matching cases below would
  // stop returning PERMIT (they would fall through to the ABSTAIN default,
  // i.e. NOT_APPLICABLE) and the obligation / structured-subject /
  // resource-replacement assertions would not hold.
  describe('content-dependent transport (proves subscription fields reach the node)', () => {
    const CONTENT_POLICIES: Readonly<Record<string, string>> = {
      'permit-doc.sapl': `policy "permit-doc"
permit
  subject == "alice";
  action == "read";
  resource == "doc-1";`,
      'permit-audit.sapl': `policy "permit-audit"
permit
  subject == "alice";
  action == "audit";
  resource == "doc-1";
obligation
  {
    "type": "logAccess",
    "message": "Document audited"
  }`,
      'permit-structured.sapl': `policy "permit-structured"
permit
  subject.name == "alice";
  subject.roles[0] == "admin";
  action == "edit";
  resource == "doc-1";
transform
  {
    "id": "doc-1",
    "redacted": true
  }`,
    };
    // ABSTAIN default decision yields NOT_APPLICABLE when no policy matches,
    // which is the crisp negative signal an all-undefined subscription lands on.
    const CONTENT_PDP_CONFIG = {
      algorithm: { votingMode: 'PRIORITY_PERMIT', defaultDecision: 'ABSTAIN', errorHandling: 'ABSTAIN' },
      variables: {},
    };
    let node: StartedSaplNode;
    let client: RsocketPdpClient;

    beforeAll(async () => {
      node = await startSaplNode({
        allowNoAuth: true,
        policies: CONTENT_POLICIES,
        pdpConfig: CONTENT_PDP_CONFIG,
      });
      client = new RsocketPdpClient({ host: node.rsocketHost, port: node.rsocketPort });
    }, 180_000);

    afterAll(async () => {
      await client.close();
      await node.stop();
    }, 60_000);

    test('whenSubscriptionMatchesContentPolicyThenPermitReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
    });

    test('whenSubscriptionActionDoesNotMatchThenNotApplicableReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'write', resource: 'doc-1' });

      expect(decision.decision).toBe('NOT_APPLICABLE');
    });

    test('whenSubscriptionSubjectDoesNotMatchThenNotApplicableReturned', async () => {
      const decision = await client.decideOnce({ subject: 'bob', action: 'read', resource: 'doc-1' });

      expect(decision.decision).toBe('NOT_APPLICABLE');
    });

    test('whenSubscriptionResourceDoesNotMatchThenNotApplicableReturned', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-2' });

      expect(decision.decision).toBe('NOT_APPLICABLE');
    });

    test('whenMatchingSubscriptionStreamedThenPermitArrives', async () => {
      const decisions = await firstValueFrom(
        client.decide({ subject: 'alice', action: 'read', resource: 'doc-1' }).pipe(take(1), toArray()),
      );

      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision).toBe('PERMIT');
    });

    test('whenPolicyEmitsObligationThenObligationRoundTripsOverRsocket', async () => {
      const decision = await client.decideOnce({ subject: 'alice', action: 'audit', resource: 'doc-1' });

      expect(decision.decision).toBe('PERMIT');
      expect(decision.obligations).toEqual([{ type: 'logAccess', message: 'Document audited' }]);
    });

    test('whenStructuredSubjectMatchesThenReplacedResourceRoundTripsOverRsocket', async () => {
      const decision = await client.decideOnce({
        subject: { name: 'alice', roles: ['admin', 'reader'] },
        action: 'edit',
        resource: 'doc-1',
      });

      expect(decision.decision).toBe('PERMIT');
      expect(decision.resource).toEqual({ id: 'doc-1', redacted: true });
    });

    test('whenStructuredSubjectDoesNotMatchThenNotApplicableReturned', async () => {
      const decision = await client.decideOnce({
        subject: { name: 'bob', roles: ['admin'] },
        action: 'edit',
        resource: 'doc-1',
      });

      expect(decision.decision).toBe('NOT_APPLICABLE');
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

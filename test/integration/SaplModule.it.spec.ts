import { readFileSync } from 'node:fs';
import { PdpService } from '../../lib/pdp.service';
import { startSaplNode, type StartedSaplNode } from './sapl-node-container';

// Exercises the module-configuration path (`buildClient` behind PdpService)
// against a real SAPL Node, rather than the transport clients directly. The
// RSocket case proves that `buildClient` now threads the `tls` option into
// the RSocket client: the Node's RSocket port speaks TLS only, so without the
// passthrough the client would connect plaintext and fail closed.
describe('SaplModule transport wiring (integration, requires docker + local sapl-node image + test fixture certs)', () => {
  let node: StartedSaplNode;
  let caPem: string;

  beforeAll(async () => {
    node = await startSaplNode({ allowNoAuth: true, tls: true });
    if (node.caPemPath === null) {
      throw new Error('TLS container did not expose caPemPath');
    }
    caPem = readFileSync(node.caPemPath, 'utf8');
  }, 240_000);

  afterAll(async () => {
    await node.stop();
  }, 60_000);

  test('whenModuleConfiguredForHttpsThenDecideOnceReturnsPermit', async () => {
    const service = new PdpService({ baseUrl: node.httpUrl, tls: { ca: caPem } });
    try {
      const decision = await service.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
      expect(decision.decision).toBe('PERMIT');
    } finally {
      await service.onModuleDestroy();
    }
  });

  test('whenModuleConfiguredForRsocketTlsThenDecideOnceReturnsPermit', async () => {
    const service = new PdpService({
      transport: 'rsocket',
      baseUrl: node.httpUrl,
      rsocketHost: node.rsocketHost,
      rsocketPort: node.rsocketPort,
      tls: { ca: caPem, servername: 'localhost' },
    });
    try {
      const decision = await service.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
      expect(decision.decision).toBe('PERMIT');
    } finally {
      await service.onModuleDestroy();
    }
  });
});

import { readFileSync } from 'node:fs';
import { HttpPdpClient } from '../../lib/transport/HttpPdpClient';
import { RsocketPdpClient } from '../../lib/transport/RsocketPdpClient';
import { startSaplNode, type StartedSaplNode } from './sapl-node-container';

describe('TLS transport (integration, requires docker + local sapl-node image + test fixture certs)', () => {
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

  describe('HttpPdpClient over HTTPS', () => {
    test('whenDecideOnceCalledOverHttpsWithCaBundleThenPermitReturned', async () => {
      const client = new HttpPdpClient({ baseUrl: node.httpUrl, tls: { ca: caPem } });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('PERMIT');
      } finally {
        await client.close();
      }
    });

    test('whenDecideOnceCalledOverHttpsWithRejectUnauthorizedFalseThenPermitReturned', async () => {
      const client = new HttpPdpClient({
        baseUrl: node.httpUrl,
        tls: { rejectUnauthorized: false },
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('PERMIT');
      } finally {
        await client.close();
      }
    });
  });

  describe('RsocketPdpClient over TLS', () => {
    test('whenDecideOnceCalledOverRsocketTlsWithCaBundleThenPermitReturned', async () => {
      const client = new RsocketPdpClient({
        host: node.rsocketHost,
        port: node.rsocketPort,
        tls: { ca: caPem, servername: 'localhost' },
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('PERMIT');
      } finally {
        await client.close();
      }
    });
  });

  describe('TLS negative paths', () => {
    test('whenHttpClientWithoutCaBundleAgainstSelfSignedCertThenFailClosedToIndeterminate', async () => {
      // No `tls` config -> Node's default trust store rejects the
      // self-signed cert. The client surfaces this as INDETERMINATE
      // (fail-closed) rather than throwing to the caller.
      const client = new HttpPdpClient({ baseUrl: node.httpUrl });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('INDETERMINATE');
      } finally {
        await client.close();
      }
    });

    test('whenHttpClientWithWrongCaBundleThenFailClosedToIndeterminate', async () => {
      // Wrong CA: pass an empty PEM "CA" that cannot validate the
      // server cert chain. Fail-closed to INDETERMINATE.
      const client = new HttpPdpClient({
        baseUrl: node.httpUrl,
        tls: {
          ca: '-----BEGIN CERTIFICATE-----\nMIIBwTCCAUOgAwIBAgIBADANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA93cm9u\nZy1mYWtlLWNlcnQwHhcNMjUwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjAaMRgw\nFgYDVQQDDA93cm9uZy1mYWtlLWNlcnQwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJ\nAoGBAMQNa2WhKAFGqv7r3Bj/JE9CIaJjJxQ7l1lZTLrTQTKxYVH6Q4ttmYO3qJ0e\nUKnK7r/lTpiE5q+/lEpqGl8mUM5RhXKvhMqxQ5x+0sRZ3FCx0pVoQUv8AGSlS8xS\nB1ZeyMxKQVl0PV7sFCQp1gN+kvCNo4SQfaJ3v9MYwTLPAgMBAAGjEDAOMAwGA1Ud\nEwQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEAr+aiOJZ3rNlhuFhVnj7GKvFhDFiQ\nyhV3sMUKlpQwUaH0H7c5fDjVjvCwdHfTuP9aSdQ7yJlPpHjN5qkpVrtPDxhWXgQK\n7g3rGKqLpHNNcfhCJ/M/QnpHfqj/eNGOKvJsPjT7G2zVvKxvNcGSh3+QQhe8FY+y\nLQRJqOQXxe4qH98=\n-----END CERTIFICATE-----',
        },
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('INDETERMINATE');
      } finally {
        await client.close();
      }
    });

    test('whenRsocketClientWithoutCaBundleAgainstSelfSignedCertThenIndeterminate', async () => {
      // RSocket TLS with no CA also fail-closes.
      const client = new RsocketPdpClient({
        host: node.rsocketHost,
        port: node.rsocketPort,
        tls: { servername: 'localhost' },
      });
      try {
        const decision = await client.decideOnce({ subject: 'alice', action: 'read', resource: 'doc-1' });
        expect(decision.decision).toBe('INDETERMINATE');
      } finally {
        await client.close();
      }
    });
  });
});

describe('TLS construction guards (no container needed)', () => {
  test('whenHttpClientPlainHttpToNonLoopbackThenConstructionThrows', () => {
    expect(() => new HttpPdpClient({ baseUrl: 'http://pdp.example.com:8443' })).toThrow(
      'plain HTTP and targets a non-loopback host',
    );
  });

  test('whenRsocketClientPlainTcpToNonLoopbackThenConstructionThrows', () => {
    expect(() => new RsocketPdpClient({ host: 'pdp.example.com', port: 7000 })).toThrow(
      'refuses to connect plaintext',
    );
  });

  test('whenHttpClientPlainHttpToLoopbackThenAllowed', () => {
    const client = new HttpPdpClient({ baseUrl: 'http://localhost:8443' });
    expect(client).toBeInstanceOf(HttpPdpClient);
  });

  test('whenRsocketClientPlainTcpToLoopbackThenAllowed', () => {
    const client = new RsocketPdpClient({ host: 'localhost', port: 7000 });
    expect(client).toBeInstanceOf(RsocketPdpClient);
  });

  test('whenRsocketClientPlainTcpToLoopbackIpv4ThenAllowed', () => {
    const client = new RsocketPdpClient({ host: '127.0.0.1', port: 7000 });
    expect(client).toBeInstanceOf(RsocketPdpClient);
  });
});

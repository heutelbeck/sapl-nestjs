# Integration tests for `@sapl/nestjs`

These tests round-trip through a real SAPL Node container and a real
RSocket / HTTP transport. They are kept out of the default `npm test`
because they need docker, a locally built (or pulled) SAPL Node image,
and many seconds per spec.

## Prerequisites

1. Docker daemon running.
2. The SAPL Node image accessible to the local docker engine:

   ```
   docker pull ghcr.io/heutelbeck/sapl-node:4.1.2
   ```

   The IT picks `ghcr.io/heutelbeck/sapl-node:4.1.2` up by default.
   Override with `SAPL_NODE_IMAGE=...` to test against another tag.

## Running

```
npm run test:it
```

If the image cannot be pulled, the IT fails at container start.
The error message names the missing image tag.

## What the IT covers

- `HttpPdpClient.it.spec.ts` — round-trips against the real PDP over
  HTTP. Covers `decideOnce`, `decide` streaming, `multiDecideAllOnce`,
  no-auth + Basic Auth transports, and a fail-closed assertion when the
  client omits credentials a Basic-auth-only Node requires.
- `RsocketPdpClient.it.spec.ts` — the same round-trip surface against
  the RSocket transport. Lands alongside the RSocket client.

## CI integration

The npm script is wired into the GitHub Actions workflow only on the
`integration-tests` job which runs on-demand (manual dispatch + nightly
schedule). Pull-request workflows run `npm test` only.

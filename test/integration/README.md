# Integration tests for `@sapl/nestjs`

These tests round-trip through a real SAPL Node container and a real
RSocket / HTTP transport. They are kept out of the default `npm test`
because they need docker, a locally built (or pulled) SAPL Node image,
and many seconds per spec.

## Prerequisites

1. Docker daemon running.
2. A SAPL Node image accessible to the local docker engine:

   ```
   cd /path/to/sapl-policy-engine
   mvn -pl sapl-node -am install -DskipTests
   mvn -pl sapl-node spring-boot:build-image -DskipTests
   ```

   After the build, `docker images` lists
   `ghcr.io/heutelbeck/sapl-node:4.1.0-SNAPSHOT`. The IT picks that tag
   up by default. Override with `SAPL_NODE_IMAGE=...` once the official
   4.1.0 release is published to GHCR.

## Running

```
npm run test:it
```

Skip the SAPL Node build steps and the IT will fail at container start.
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

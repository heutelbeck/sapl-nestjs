# Changelog

## 2.0.0 — 2026-05-25

Major release: aligns `@sapl/nestjs` with the SAPL 4.1 streaming PEP
model, adds RSocket transport, and collapses the three legacy
streaming decorators into one.

### Breaking changes

- **Streaming decorators collapsed to one.** `@EnforceTillDenied`,
  `@EnforceDropWhileDenied`, and `@EnforceRecoverableIfDenied` are
  removed. Replace with `@StreamEnforce` plus the flags
  `signalTransitions` / `pauseRapDuringSuspend` and the subscriber-
  side `TransitionSignals` operators. Strict fail-closed makes any
  `DENY` unconditionally terminal; policies that want
  pause-instead-of-terminate emit the new `SUSPEND` decision verb.

  | Legacy 1.x decorator | 2.0 equivalent |
  |---|---|
  | `@EnforceTillDenied` | `@StreamEnforce()` |
  | `@EnforceDropWhileDenied` | Policy emits `SUSPEND` while paused; `@StreamEnforce()` drops items silently while suspended |
  | `@EnforceRecoverableIfDenied` | Policy emits `SUSPEND`; `@StreamEnforce({ signalTransitions: true })` + `TransitionSignals.onSuspend` / `onGranted` |

- **`Decision` union widened with `'SUSPEND'`.** Exhaustive switches
  on `decision.decision` need a new branch (typically routed like
  `DENY` for one-shot callers) or a `default:` arm.

- **`SaplModuleOptions.transport`.** Defaults to `'http'`; set
  `'rsocket'` plus `rsocketHost` / `rsocketPort` to opt into the
  binary transport. `baseUrl` stays required (used as the RSocket
  host fallback).

- **`multiDecide*` wire format fixed.** v1.x posted
  `{ "subscriptions": {...} }`; the SAPL Node expects the flat
  `{ id: {...} }` form. Fixed in `HttpPdpClient`; no client-side API
  change.

### Added

- `@StreamEnforce` decorator with `signalTransitions` and
  `pauseRapDuringSuspend` flags.
- `TransitionSignals` operators (`onSuspend`, `onGranted`,
  `onTransitions`) for subscriber-side boundary handling.
- Four-state Mealy FSM (`Pending` / `Permitting` / `Suspended` /
  `Terminated`) backing the streaming pipeline.
- RSocket transport (`@rsocket/core`) with protobuf-encoded
  subscriptions / decisions and connection-level auth (basic /
  API-key / OAuth2 bearer).
- `OAuth2TokenProvider` wrapping `openid-client` for
  `client_credentials` + automatic refresh.
- Boundary signal types: `AccessSuspendedSignal` / `AccessGrantedSignal`
  on the `next` channel; terminal `AccessDeniedError` (extends
  NestJS `ForbiddenException`) on the `error` channel.
- Integration test suite (`npm run test:it`) against a real SAPL
  Node container, covering HTTP and RSocket with each auth mode.

### Removed

- `@EnforceTillDenied`, `@EnforceDropWhileDenied`,
  `@EnforceRecoverableIfDenied` and their option / handler types.
- `StreamingEnforcementCore` and its 3-state ad-hoc state machine.

### Notes

- Minimum Node version unchanged at `>= 20.0.0`.

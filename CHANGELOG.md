# Changelog

## 2.0.0 — 2026-05-25

Major release. Re-architects enforcement from the legacy
constraint-bundle model to the SAPL 4.1 planner + `@StreamEnforce`
model; adds RSocket transport, support for the new `SUSPEND` decision
verb, and data-layer query rewriting (Mongoose + Prisma).

### Breaking changes

- **Enforcement re-architected to a planner + signal model.** The
  legacy `ConstraintEnforcementService` / `ConstraintHandlerBundle`
  model is replaced by an `EnforcementPlanner` that binds constraint
  handlers to lifecycle signals (`decision` / `input` / `output` /
  `error`, and the streaming signals). The `ConstraintHandlerProvider`
  interface changed shape: a provider now returns scoped handlers
  (`getHandlers(constraint): ScopedHandler[]`) targeting a signal,
  rather than the 1.x bundle API. Custom 1.x constraint handlers must
  be rewritten against the new interface.

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
- Data-layer query rewriting: a `mongo:queryRewriting` /
  `sql:queryRewriting` obligation transparently narrows the queries an
  enforced method issues, fail-closed and narrowing-only. `@sapl/nestjs/mongoose`
  (Mongoose plugin + `MongoDbQueryRewritingProvider`) and `@sapl/nestjs/prisma`
  (Prisma client extension + `SqlQueryRewritingProvider`) ship as subpath
  exports with `mongoose` / `@prisma/client` as optional peer dependencies.
- Shim-signal registry (`registerShimSignal` / `shimSignals`) and a
  request-scoped active plan (`activePlan`) so a data-layer shim can
  discharge its obligation at query time within the `@PreEnforce` scope.

### Removed

- `@EnforceTillDenied`, `@EnforceDropWhileDenied`,
  `@EnforceRecoverableIfDenied` and their option / handler types.
- `StreamingEnforcementCore` and its 3-state ad-hoc state machine.
- Legacy enforcement core: `ConstraintEnforcementService`,
  `ConstraintHandlerBundle`, `StreamingConstraintHandlerBundle`.

### Notes

- **Minimum Node version bumped to `>= 22.0.0`.** `undici@8` (the
  underlying HTTP/2 client) dropped Node 20 support. CI matrix
  now runs Node 22 + 24.

# @sapl/nestjs

Policy-based authorization for NestJS. Write access control rules as external SAPL policy files and enforce them at runtime through decorators like `@PreEnforce` and `@PostEnforce`. Policies can be updated without code changes or redeployment.

## How It Works

![Architecture](https://raw.githubusercontent.com/heutelbeck/sapl-nestjs/main/docs/architecture.svg)

Your application decorates methods with enforcement decorators. SAPL intercepts the call, sends an authorization subscription to the Policy Decision Point (PDP), and enforces the decision, including any obligations or advice the policy attaches.

```typescript
@PreEnforce({ action: 'read', resource: 'patient' })
@Get('patient')
getPatient() {
  return { name: 'Jane Doe', ssn: '123-45-6789' };
}
```

```
policy "permit doctors to read patient data"
permit
  action == "read";
  "DOCTOR" in subject.roles
```

If the PDP permits, the method runs. If not, a `ForbiddenException` is thrown. If the decision carries obligations (like access logging or field redaction), they are enforced automatically through registered constraint handlers.

## What You Get

SAPL goes beyond simple permit/deny. Decisions can carry obligations that must be fulfilled, advice that should be attempted, and resource transformations that modify return values before they reach the caller. The library handles all of this transparently.

For SSE endpoints returning `Observable<T>`, streaming decorators (`@EnforceTillDenied`, `@EnforceDropWhileDenied`, `@EnforceRecoverableIfDenied`) maintain a live connection to the PDP, so access rights update in real time as policies, attributes, or the environment change. Transaction integration via `@nestjs-cls/transactional` ensures that obligation failures after a database write trigger a rollback. Built-in constraint handlers cover JSON field redaction and collection filtering. Writing custom handlers follows standard NestJS patterns with `@Injectable()` and `@SaplConstraintHandler()`.

## Getting Started

```bash
npm install @sapl/nestjs @toss/nestjs-aop nestjs-cls
```

For setup instructions, configuration options, the constraint handler reference, and the full API, see the [NestJS documentation](https://sapl.io/docs/latest/6_5_NestJS/).

## Links

- [Full Documentation](https://sapl.io/docs/latest/)
- [NestJS Integration](https://sapl.io/docs/latest/6_5_NestJS/)
- [Demo Application](https://github.com/heutelbeck/sapl-nestjs-demo)
- [Report an Issue](https://github.com/heutelbeck/sapl-nestjs/issues)

## License

Apache-2.0

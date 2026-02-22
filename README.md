# @sapl/nestjs

Attribute-Based Access Control (ABAC) for NestJS using SAPL (Streaming Attribute Policy Language). Provides decorator-driven policy enforcement with a constraint handler architecture for obligations, advice, and response transformation.

## Installation

```bash
npm install @sapl/nestjs @toss/nestjs-aop nestjs-cls
```

## Setup

### Direct Configuration

```typescript
import { Module } from '@nestjs/common';
import { SaplModule } from '@sapl/nestjs';

@Module({
  imports: [
    SaplModule.forRoot({
      baseUrl: 'http://localhost:8443',
      token: 'sapl_your_token_here',
    }),
  ],
})
export class AppModule {}
```

### Async Configuration

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SaplModule } from '@sapl/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    SaplModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.get('SAPL_PDP_URL', 'http://localhost:8443'),
        token: config.get('SAPL_PDP_TOKEN'),
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

`SaplModule` registers everything automatically:
- `PdpService` for PDP communication
- `ConstraintEnforcementService` for constraint handler discovery and orchestration
- `PreEnforceAspect` and `PostEnforceAspect` via `@toss/nestjs-aop`
- `ClsModule` from `nestjs-cls` for request context propagation
- Built-in `ContentFilteringProvider` and `ContentFilterPredicateProvider`

The decorators work on any injectable class method -- controllers, services, repositories, etc. Methods without `@PreEnforce()` or `@PostEnforce()` are unaffected.

## Decorators

### @PreEnforce

Authorizes **before** the method executes. The method only runs on PERMIT. Works on any injectable class method.

```typescript
import { Controller, Get } from '@nestjs/common';
import { PreEnforce } from '@sapl/nestjs';

@Controller('api')
export class PatientController {
  @PreEnforce({ action: 'read', resource: 'patient' })
  @Get('patient')
  getPatient() {
    return { name: 'Jane Doe', ssn: '123-45-6789' };
  }
}
```

Use `@PreEnforce` for methods with side effects (database writes, emails) that should not execute when access is denied.

### @PostEnforce

Authorizes **after** the method executes. The method always runs; its return value is available via `ctx.returnValue` in subscription field callbacks.

```typescript
@PostEnforce({
  action: 'read',
  resource: (ctx) => ({ type: 'record', data: ctx.returnValue }),
})
@Get('record/:id')
getRecord(@Param('id') id: string) {
  return { id, value: 'sensitive-data' };
}
```

Use `@PostEnforce` when the PDP needs to see the return value for its decision, or when you want to transform the response based on the decision.

### Subscription Fields

Both decorators accept `EnforceOptions` to customize the authorization subscription:

```typescript
type SubscriptionField<T = any> = T | ((ctx: SubscriptionContext) => T);
```

The `SubscriptionContext` provides:

| Field         | Type                       | Description                                              |
|---------------|----------------------------|----------------------------------------------------------|
| `request`     | `any`                      | Full Express request (`req.user`, `req.headers`, etc.)   |
| `params`      | `Record<string, string>`   | Route parameters (`@Get(':id')` -> `ctx.params.id`)      |
| `query`       | `Record<string, string>`   | Query string parameters                                  |
| `body`        | `any`                      | Request body (POST/PUT)                                  |
| `handler`     | `string`                   | Handler method name                                      |
| `controller`  | `string`                   | Controller class name                                    |
| `returnValue` | `any`                      | Handler return value (`@PostEnforce` only)                |
| `args`        | `any[]`                    | Method arguments                                         |

#### Default Values

| Field         | Default                                                                 |
|---------------|-------------------------------------------------------------------------|
| `subject`     | `req.user` (decoded JWT claims from auth guard)                         |
| `action`      | `{ method, controller, handler }`                                       |
| `resource`    | `{ path, params }`                                                      |
| `environment` | `{ ip, hostname }` plus select headers if present                       |
| `secrets`     | Not sent unless explicitly specified                                    |

### Custom Deny Handling

```typescript
@PreEnforce({
  onDeny: (ctx, decision) => ({
    error: 'access_denied',
    decision: decision.decision,
    user: ctx.request.user?.preferred_username ?? 'unknown',
  }),
})
```

## Constraint Handlers

When the PDP returns a decision with `obligations` or `advice`, the `ConstraintEnforcementService` builds a `ConstraintHandlerBundle` that orchestrates all constraint handlers.

### Obligation vs. Advice Semantics

| Aspect            | Obligation                                                        | Advice                                          |
|-------------------|-------------------------------------------------------------------|-------------------------------------------------|
| All handled?      | Required. Unhandled obligations deny access (ForbiddenException). | Optional. Unhandled advice is silently ignored. |
| Handler failure   | Denies access (ForbiddenException).                               | Logs a warning and continues.                   |

### Handler Types

| Type               | Interface                                   | Handler Signature           | When It Runs                        |
|--------------------|---------------------------------------------|-----------------------------|-------------------------------------|
| `runnable`         | `RunnableConstraintHandlerProvider`         | `() => void`                | On decision (side effects)          |
| `methodInvocation` | `MethodInvocationConstraintHandlerProvider` | `(request: any) => void`    | Before handler (`@PreEnforce` only) |
| `consumer`         | `ConsumerConstraintHandlerProvider`         | `(value: any) => void`      | After handler, inspects response    |
| `mapping`          | `MappingConstraintHandlerProvider`          | `(value: any) => any`       | After handler, transforms response  |
| `filterPredicate`  | `FilterPredicateConstraintHandlerProvider`  | `(element: any) => boolean` | After handler, filters elements     |
| `errorHandler`     | `ErrorHandlerProvider`                      | `(error: Error) => void`    | On error, inspects                  |
| `errorMapping`     | `ErrorMappingConstraintHandlerProvider`     | `(error: Error) => Error`   | On error, transforms                |

### Registering Custom Handlers

```typescript
import { Injectable } from '@nestjs/common';
import {
  SaplConstraintHandler,
  RunnableConstraintHandlerProvider,
  Signal,
} from '@sapl/nestjs';

@Injectable()
@SaplConstraintHandler('runnable')
export class AuditLogHandler implements RunnableConstraintHandlerProvider {
  isResponsible(constraint: any): boolean {
    return constraint?.type === 'logAccess';
  }

  getSignal(): Signal {
    return Signal.ON_DECISION;
  }

  getHandler(constraint: any): () => void {
    return () => console.log(`Audit: ${constraint.message}`);
  }
}
```

Register the handler in any module's `providers` array. The `ConstraintEnforcementService` discovers all `@SaplConstraintHandler`-decorated providers automatically.

## Built-in Constraint Handlers

### ContentFilteringProvider

**Constraint type:** `filterJsonContent`

Transforms response values by deleting, replacing, or blackening fields.

```json
{
  "type": "filterJsonContent",
  "actions": [
    { "type": "blacken", "path": "$.ssn", "discloseRight": 4 },
    { "type": "delete", "path": "$.internalNotes" },
    { "type": "replace", "path": "$.classification", "replacement": "REDACTED" }
  ]
}
```

### ContentFilterPredicateProvider

**Constraint type:** `jsonContentFilterPredicate`

Filters array elements or nullifies single values that do not meet conditions.

```json
{
  "type": "jsonContentFilterPredicate",
  "conditions": [
    { "path": "$.classification", "type": "!=", "value": "top-secret" }
  ]
}
```

### ContentFilter Limitations

The built-in content filter supports **simple dot-notation paths only** (`$.field.nested`). Recursive descent (`$..ssn`), bracket notation (`$['field']`), array indexing (`$.items[0]`), wildcards (`$.users[*].email`), and filter expressions (`$.books[?(@.price<10)]`) are not supported and will throw an error.

## Manual PDP Access

```typescript
import { PdpService } from '@sapl/nestjs';

@Controller('api')
export class AppController {
  constructor(private readonly pdpService: PdpService) {}

  @Get('hello')
  async getHello(@Request() req) {
    const decision = await this.pdpService.decideOnce({
      subject: req.user,
      action: 'read',
      resource: 'hello',
    });

    if (decision.decision === 'PERMIT' && !decision.obligations?.length) {
      return { message: 'Hello World' };
    }
    throw new ForbiddenException('Access denied');
  }
}
```

## Advanced Configuration

### Using nestjs-cls in Your Application

`SaplModule` manages `ClsModule` from `nestjs-cls` automatically. CLS middleware is mounted globally and the HTTP request is stored at the `CLS_REQ` key.

**If you already use `nestjs-cls`:** Remove your own `ClsModule.forRoot()` call. Since `ClsService` is globally available, inject it anywhere to set/get custom CLS values as before. Your interceptors and guards that use `ClsService` continue to work unchanged.

**If you need custom CLS options** (custom `idGenerator`, `setup` callback, guard/interceptor mode instead of middleware): Pass them via the `cls` option in `SaplModule.forRoot()`:

```typescript
SaplModule.forRoot({
  baseUrl: 'http://localhost:8443',
  cls: {
    middleware: {
      mount: true,
      setup: (cls, req) => {
        cls.set('TENANT_ID', req.headers['x-tenant-id']);
      },
    },
  },
})
```

The `cls` options are merged into the default configuration (`{ global: true, middleware: { mount: true } }`), so you only need to specify the parts you want to customize.

## License

Apache-2.0

// Module
export { SaplModule } from './sapl.module';
export { SAPL_MODULE_OPTIONS } from './sapl.constants';
export { SaplModuleOptions, SaplModuleAsyncOptions } from './sapl.interfaces';
export { SaplTransactionAdapter } from './SaplTransactionAdapter';

// Types
export {
  Decision,
  AuthorizationDecision,
  AuthorizationSubscription,
  MultiAuthorizationSubscription,
  IdentifiableAuthorizationDecision,
  MultiAuthorizationDecision,
} from './types';

// PDP
export { PdpService } from './pdp.service';

// Transports
export type { PdpClient } from './transport/PdpClient';
export { HttpPdpClient, type HttpPdpClientOptions } from './transport/HttpPdpClient';
export { RsocketPdpClient, type RsocketPdpClientOptions } from './transport/RsocketPdpClient';
export type { TlsConfig } from './transport/TlsConfig';
export { OAuth2TokenProvider, type OAuth2TokenProviderOptions } from './transport/auth/OAuth2TokenProvider';

// Decorators
export { PreEnforce } from './PreEnforce';
export { PostEnforce } from './PostEnforce';
export { StreamEnforce, StreamEnforceOptions } from './streaming/StreamEnforce';

// Boundary signals
export { AccessDeniedError, AccessSuspendedSignal, AccessGrantedSignal } from './streaming/BoundarySignals';
export { TransitionSignals } from './streaming/TransitionSignals';

// Options and context
export { SubscriptionOptions, SubscriptionField } from './SubscriptionOptions';
export { SaplRequest, SubscriptionContext } from './SubscriptionContext';

// Constraint handler API
export type { ConstraintHandlerProvider, ScopedHandler, HandlerShape } from './constraints/api/index';
export type { Signal, SignalKind } from './constraints/Signal';

// Constraint handler registration
export { SaplConstraintHandler, ConstraintHandlerType } from './constraints/SaplConstraintHandler';

// Constraint enforcement planner
export { EnforcementPlanner } from './constraints/Planner';

import { loadSync } from 'protobufjs';
import { resolve } from 'node:path';
import {
  DECISION_BY_INT,
  INT_BY_DECISION,
  type AuthorizationDecision,
  type AuthorizationSubscription,
  type Decision,
  type IdentifiableAuthorizationDecision,
  type MultiAuthorizationDecision,
  type MultiAuthorizationSubscription,
} from '../../types';
import { SaplValueCodec } from './SaplValueCodec';

/**
 * Wire codec for the RSocket transport. Loads the `sapl_types.proto`
 * file at construction (synchronous, file-system access) and exposes
 * encode / decode for the four message types the streaming PEP uses
 * over RSocket.
 */
export class SaplProtoCodec {
  private readonly subscriptionType;
  private readonly decisionType;
  private readonly identifiableSubscriptionType;
  private readonly identifiableDecisionType;
  private readonly multiSubscriptionType;
  private readonly multiDecisionType;
  private readonly valueCodec;

  constructor() {
    const loaded = loadSync([
      resolve(__dirname, 'sapl_types.proto'),
      resolve(__dirname, 'sapl_service.proto'),
    ]);
    this.subscriptionType = loaded.lookupType('io.sapl.api.proto.AuthorizationSubscription');
    this.decisionType = loaded.lookupType('io.sapl.api.proto.AuthorizationDecision');
    this.identifiableSubscriptionType = loaded.lookupType(
      'io.sapl.api.proto.IdentifiableAuthorizationSubscription',
    );
    this.identifiableDecisionType = loaded.lookupType('io.sapl.api.proto.IdentifiableAuthorizationDecision');
    this.multiSubscriptionType = loaded.lookupType('io.sapl.api.proto.MultiAuthorizationSubscription');
    this.multiDecisionType = loaded.lookupType('io.sapl.api.proto.MultiAuthorizationDecision');
    this.valueCodec = new SaplValueCodec();
  }

  encodeSubscription(subscription: AuthorizationSubscription): Buffer {
    const payload = {
      subject: this.valueCodec.encode(subscription.subject),
      action: this.valueCodec.encode(subscription.action),
      resource: this.valueCodec.encode(subscription.resource),
      environment: this.valueCodec.encode(subscription.environment),
      secrets: this.valueCodec.encode(subscription.secrets),
    };
    const message = this.subscriptionType.create(payload);
    return Buffer.from(this.subscriptionType.encode(message).finish());
  }

  decodeDecision(buffer: Buffer): AuthorizationDecision {
    const decoded = this.decisionType.decode(buffer).toJSON() as {
      decision?: string | number;
      obligations?: { elements?: unknown[] };
      advice?: { elements?: unknown[] };
      resource?: unknown;
    };
    const decisionVerb = normaliseDecision(decoded.decision);
    const result: AuthorizationDecision = { decision: decisionVerb };
    if (decoded.obligations && Array.isArray(decoded.obligations.elements)) {
      result.obligations = decoded.obligations.elements.map((element) => this.valueCodec.decode(element));
    }
    if (decoded.advice && Array.isArray(decoded.advice.elements)) {
      result.advice = decoded.advice.elements.map((element) => this.valueCodec.decode(element));
    }
    if (decoded.resource !== undefined) {
      result.resource = this.valueCodec.decode(decoded.resource);
    }
    return result;
  }

  encodeMultiSubscription(subscription: MultiAuthorizationSubscription): Buffer {
    const subs: unknown[] = [];
    for (const [id, sub] of Object.entries(subscription.subscriptions)) {
      const identifiable = this.identifiableSubscriptionType.create({
        subscriptionId: id,
        subscription: {
          subject: this.valueCodec.encode(sub.subject),
          action: this.valueCodec.encode(sub.action),
          resource: this.valueCodec.encode(sub.resource),
          environment: this.valueCodec.encode(sub.environment),
          secrets: this.valueCodec.encode(sub.secrets),
        },
      });
      subs.push(identifiable);
    }
    const message = this.multiSubscriptionType.create({ subscriptions: subs });
    return Buffer.from(this.multiSubscriptionType.encode(message).finish());
  }

  decodeIdentifiableDecision(buffer: Buffer): IdentifiableAuthorizationDecision {
    const decoded = this.identifiableDecisionType.decode(buffer).toJSON() as {
      subscriptionId?: string;
      decision?: {
        decision?: string | number;
        obligations?: { elements?: unknown[] };
        advice?: { elements?: unknown[] };
        resource?: unknown;
      };
    };
    const subscriptionId = decoded.subscriptionId ?? '';
    const decisionPayload = decoded.decision ?? {};
    const inner = this.decisionFromJson(decisionPayload);
    return { subscriptionId, decision: inner };
  }

  decodeMultiDecision(buffer: Buffer): MultiAuthorizationDecision {
    const decoded = this.multiDecisionType.decode(buffer).toJSON() as {
      decisions?: Record<
        string,
        {
          decision?: string | number;
          obligations?: { elements?: unknown[] };
          advice?: { elements?: unknown[] };
          resource?: unknown;
        }
      >;
    };
    const decisions: Record<string, AuthorizationDecision> = {};
    for (const [id, payload] of Object.entries(decoded.decisions ?? {})) {
      decisions[id] = this.decisionFromJson(payload);
    }
    return { decisions };
  }

  private decisionFromJson(payload: {
    decision?: string | number;
    obligations?: { elements?: unknown[] };
    advice?: { elements?: unknown[] };
    resource?: unknown;
  }): AuthorizationDecision {
    const verb = normaliseDecision(payload.decision);
    const result: AuthorizationDecision = { decision: verb };
    if (payload.obligations && Array.isArray(payload.obligations.elements)) {
      result.obligations = payload.obligations.elements.map((element) => this.valueCodec.decode(element));
    }
    if (payload.advice && Array.isArray(payload.advice.elements)) {
      result.advice = payload.advice.elements.map((element) => this.valueCodec.decode(element));
    }
    if (payload.resource !== undefined) {
      result.resource = this.valueCodec.decode(payload.resource);
    }
    return result;
  }
}

function normaliseDecision(raw: unknown): Decision {
  if (typeof raw === 'string' && raw in INT_BY_DECISION) {
    return raw as Decision;
  }
  if (typeof raw === 'number' && raw in DECISION_BY_INT) {
    return DECISION_BY_INT[raw];
  }
  return 'INDETERMINATE';
}

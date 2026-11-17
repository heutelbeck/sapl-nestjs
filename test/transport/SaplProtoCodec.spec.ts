import { loadSync, Reader, type Type } from 'protobufjs';
import { resolve } from 'node:path';
import { SaplProtoCodec } from '../../lib/transport/codec/SaplProtoCodec';

/**
 * The secrets of a subscription travel as an `ObjectValue` message, as the
 * schema declares. A PDP refuses a subscription whose secrets are encoded any
 * other way, so these tests inspect the produced bytes instead of trusting a
 * codec-only round trip.
 */
describe('SaplProtoCodec secrets on the wire', () => {
  const SECRETS_FIELD = 5;
  const OBJECT_FIELDS_TAG = 0x0a;
  const subscription = { subject: 'alice', action: 'read', resource: 'document' };

  let subscriptionType: Type;
  let multiSubscriptionType: Type;
  let codec: SaplProtoCodec;

  beforeAll(() => {
    const loaded = loadSync(resolve(__dirname, '../../lib/transport/codec/sapl_types.proto'));
    subscriptionType = loaded.lookupType('io.sapl.api.proto.AuthorizationSubscription');
    multiSubscriptionType = loaded.lookupType('io.sapl.api.proto.MultiAuthorizationSubscription');
  });

  beforeEach(() => {
    codec = new SaplProtoCodec();
  });

  const payloadOfSecretsField = (bytes: Uint8Array): Uint8Array | undefined => {
    const reader = Reader.create(bytes);
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      if (tag >>> 3 === SECRETS_FIELD) {
        return reader.bytes();
      }
      reader.skipType(tag & 7);
    }
    return undefined;
  };

  it('encodes secrets as an object message', () => {
    const bytes = codec.encodeSubscription({ ...subscription, secrets: { apiKey: 's3cr3t', port: 5432 } });

    expect(subscriptionType.decode(bytes).toJSON().secrets).toEqual({
      fields: { apiKey: { textValue: 's3cr3t' }, port: { numberValue: '5432' } },
    });
    expect(payloadOfSecretsField(bytes)?.[0]).toBe(OBJECT_FIELDS_TAG);
  });

  it('omits the secrets field when the subscription has no secrets', () => {
    const bytes = codec.encodeSubscription(subscription);

    expect(payloadOfSecretsField(bytes)).toBeUndefined();
  });

  it.each([
    ['a string', 'token'],
    ['a number', 42],
    ['an array', ['token']],
    ['null', null],
  ])('refuses secrets that are %s', (_label, secrets) => {
    expect(() => codec.encodeSubscription({ ...subscription, secrets })).toThrow(
      'The secrets of an authorization subscription must be an object.',
    );
  });

  it('encodes the secrets of every subscription of a multi-subscription as an object message', () => {
    const bytes = codec.encodeMultiSubscription({
      subscriptions: { first: { ...subscription, secrets: { apiKey: 's3cr3t' } }, second: subscription },
    });

    const decoded = multiSubscriptionType.decode(bytes).toJSON() as {
      subscriptions: { subscriptionId: string; subscription: { secrets?: unknown } }[];
    };
    const secretsById = Object.fromEntries(
      decoded.subscriptions.map((entry) => [entry.subscriptionId, entry.subscription.secrets]),
    );
    expect(secretsById).toEqual({
      first: { fields: { apiKey: { textValue: 's3cr3t' } } },
      second: undefined,
    });
  });
});

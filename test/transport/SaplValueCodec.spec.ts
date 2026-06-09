import { loadSync, type Type } from 'protobufjs';
import { resolve } from 'node:path';
import { SaplValueCodec } from '../../lib/transport/codec/SaplValueCodec';

/**
 * Wire-level round trip through the real protobuf `Value` message. protobufjs
 * canonicalises proto field names to camelCase, so a codec that emits the
 * snake_case oneof keys declared in the .proto has its keys silently dropped
 * by `Type.create`, serialising every value to an empty submessage. These
 * tests encode through the actual proto type and decode the produced bytes,
 * which is the only way to catch that mismatch (a codec-only round trip is
 * self-consistent and passes regardless).
 */
describe('SaplValueCodec wire round trip', () => {
  let valueType: Type;
  let codec: SaplValueCodec;

  beforeAll(() => {
    const loaded = loadSync(resolve(__dirname, '../../lib/transport/codec/sapl_types.proto'));
    valueType = loaded.lookupType('io.sapl.api.proto.Value');
  });

  beforeEach(() => {
    codec = new SaplValueCodec();
  });

  const roundTrip = (value: unknown): unknown => {
    const message = valueType.create(codec.encode(value));
    const bytes = valueType.encode(message).finish();
    return codec.decode(valueType.decode(bytes).toJSON());
  };

  it.each([
    ['string', 'anonymous'],
    ['number', 42],
    ['boolean true', true],
    ['nested object', { name: 'alice', age: 30 }],
    ['array of strings', ['read', 'write']],
  ])('preserves a %s through a protobuf encode/decode cycle', (_label, value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  it('preserves undefined as the undefined sentinel', () => {
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it('serialises a populated message rather than dropping it to empty bytes', () => {
    const message = valueType.create(codec.encode('anonymous'));
    const bytes = valueType.encode(message).finish();

    expect(bytes.length).toBeGreaterThan(0);
    expect(valueType.decode(bytes).toJSON()).toEqual({ textValue: 'anonymous' });
  });
});

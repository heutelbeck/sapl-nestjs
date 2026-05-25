/**
 * Bidirectional converter between protobuf `Value` (the `oneof` defined
 * in `sapl_types.proto`) and ordinary JS values that NestJS application
 * code emits. The mapping mirrors the Java `SaplProtobufCodec.Value`
 * decoder exactly so the wire is interchangeable between Java + TS PEPs.
 *
 * Coverage:
 * - `null` JS value <-> `null_value` proto.
 * - `boolean` <-> `bool_value`.
 * - `number` and `bigint` <-> `number_value` (transported as string for
 *   BigDecimal precision in Java).
 * - `string` <-> `text_value`.
 * - `Array<unknown>` <-> `array_value`.
 * - plain object <-> `object_value`.
 * - `undefined` <-> `undefined_value` (the sentinel used by SAPL when a
 *   subscription field is missing or an expression evaluates to no value).
 *
 * Out of scope here:
 * - `ErrorValue` decoding emits a JS `Error` instance with the message;
 *   ErrorValue encoding from JS is not supported because authorization
 *   subscriptions do not carry policy-evaluation errors as inputs.
 */
export class SaplValueCodec {
  encode(value: unknown): Record<string, unknown> {
    if (value === undefined) {
      return { undefined_value: true };
    }
    if (value === null) {
      return { null_value: {} };
    }
    if (typeof value === 'boolean') {
      return { bool_value: value };
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return { number_value: String(value) };
    }
    if (typeof value === 'string') {
      return { text_value: value };
    }
    if (Array.isArray(value)) {
      return { array_value: { elements: value.map((element) => this.encode(element)) } };
    }
    if (typeof value === 'object') {
      const fields: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        fields[key] = this.encode(child);
      }
      return { object_value: { fields } };
    }
    throw new Error(`SaplValueCodec cannot encode value of type ${typeof value}`);
  }

  decode(value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    const oneOf = value as Record<string, unknown>;
    if ('undefined_value' in oneOf && oneOf.undefined_value === true) {
      return undefined;
    }
    if ('null_value' in oneOf) {
      return null;
    }
    if ('bool_value' in oneOf) {
      return oneOf.bool_value;
    }
    if ('number_value' in oneOf && typeof oneOf.number_value === 'string') {
      return Number(oneOf.number_value);
    }
    if ('text_value' in oneOf) {
      return oneOf.text_value;
    }
    if ('array_value' in oneOf && oneOf.array_value) {
      const arrayValue = oneOf.array_value as { elements?: unknown[] };
      return (arrayValue.elements ?? []).map((element) => this.decode(element));
    }
    if ('object_value' in oneOf && oneOf.object_value) {
      const objectValue = oneOf.object_value as { fields?: Record<string, unknown> };
      const decoded: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(objectValue.fields ?? {})) {
        decoded[key] = this.decode(child);
      }
      return decoded;
    }
    if ('error_value' in oneOf && oneOf.error_value) {
      const errorValue = oneOf.error_value as { message?: string };
      return new Error(errorValue.message ?? 'SAPL error value');
    }
    return undefined;
  }
}

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
      return { undefinedValue: true };
    }
    if (value === null) {
      return { nullValue: {} };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return { numberValue: String(value) };
    }
    if (typeof value === 'string') {
      return { textValue: value };
    }
    if (Array.isArray(value)) {
      return { arrayValue: { elements: value.map((element) => this.encode(element)) } };
    }
    if (typeof value === 'object') {
      const fields: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        fields[key] = this.encode(child);
      }
      return { objectValue: { fields } };
    }
    throw new Error(`SaplValueCodec cannot encode value of type ${typeof value}`);
  }

  decode(value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    const oneOf = value as Record<string, unknown>;
    if ('undefinedValue' in oneOf && oneOf.undefinedValue === true) {
      return undefined;
    }
    if ('nullValue' in oneOf) {
      return null;
    }
    if ('boolValue' in oneOf) {
      return oneOf.boolValue;
    }
    if ('numberValue' in oneOf && typeof oneOf.numberValue === 'string') {
      return Number(oneOf.numberValue);
    }
    if ('textValue' in oneOf) {
      return oneOf.textValue;
    }
    if ('arrayValue' in oneOf && oneOf.arrayValue) {
      const arrayValue = oneOf.arrayValue as { elements?: unknown[] };
      return (arrayValue.elements ?? []).map((element) => this.decode(element));
    }
    if ('objectValue' in oneOf && oneOf.objectValue) {
      const objectValue = oneOf.objectValue as { fields?: Record<string, unknown> };
      const decoded: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(objectValue.fields ?? {})) {
        decoded[key] = this.decode(child);
      }
      return decoded;
    }
    if ('errorValue' in oneOf && oneOf.errorValue) {
      const errorValue = oneOf.errorValue as { message?: string };
      return new Error(errorValue.message ?? 'SAPL error value');
    }
    return undefined;
  }
}

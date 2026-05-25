/**
 * Shared TLS configuration for both transports. Matches Node's
 * `tls.connectOptions` shape and convention: callers pass PEM
 * **contents** (string or Buffer), not file paths. Load from disk
 * with `fs.readFileSync` if needed; this library never reads files.
 *
 * `servername` is meaningful only for SNI on RSocket / raw TCP. The
 * HTTP transport derives SNI from the URL hostname and ignores it.
 */
export interface TlsConfig {
  /** PEM-encoded CA bundle the client uses to validate the PDP cert. */
  readonly ca?: string | Buffer | Array<string | Buffer>;
  /** PEM-encoded client cert contents for mTLS. */
  readonly cert?: string | Buffer;
  /** PEM-encoded client key contents for mTLS. */
  readonly key?: string | Buffer;
  /** Server name for SNI / certificate validation (RSocket only). Defaults to `host`. */
  readonly servername?: string;
  /**
   * Defaults to true. Set to false ONLY in tests against self-signed
   * certs without a provided CA. Production MUST leave true.
   */
  readonly rejectUnauthorized?: boolean;
}

// Manual mock for the ESM-only `openid-client` package. jest's CJS runtime
// cannot load the real module, so this stub is used automatically for any
// test that imports it (directly or transitively via PdpService). Specs that
// need controllable behaviour override it with their own jest.mock factory.
export const discovery = jest.fn();
export const clientCredentialsGrant = jest.fn();
export const ClientSecretPost = (secret: string): string => secret;
export class Configuration {}

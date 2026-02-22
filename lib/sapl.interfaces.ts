import { ModuleMetadata } from '@nestjs/common';

export interface SaplModuleOptions {
  /** Base URL of the SAPL PDP server (e.g., 'http://localhost:8443') */
  baseUrl: string;
  /** Bearer token for PDP REST API authentication (optional for noauth mode) */
  token?: string;
}

export interface SaplOptionsFactory {
  createSaplOptions(): Promise<SaplModuleOptions> | SaplModuleOptions;
}

export interface SaplModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<SaplModuleOptions> | SaplModuleOptions;
  inject?: any[];
}

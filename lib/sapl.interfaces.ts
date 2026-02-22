import { ModuleMetadata } from '@nestjs/common';
import { ClsModuleOptions } from 'nestjs-cls';

export interface SaplModuleOptions {
  /** Base URL of the SAPL PDP server (e.g., 'http://localhost:8443') */
  baseUrl: string;
  /** Bearer token for PDP REST API authentication (optional for noauth mode) */
  token?: string;
  /** Timeout in milliseconds for PDP HTTP requests (default: 5000) */
  timeout?: number;
  /** Options merged into ClsModule.forRoot(). Default: { global: true, middleware: { mount: true } } */
  cls?: Partial<ClsModuleOptions>;
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

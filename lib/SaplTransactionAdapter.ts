import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions } from './sapl.interfaces';

@Injectable()
export class SaplTransactionAdapter {
  private readonly logger = new Logger(SaplTransactionAdapter.name);
  private host: any = null;
  private resolved = false;
  private readonly enabled: boolean;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(SAPL_MODULE_OPTIONS) options: SaplModuleOptions,
  ) {
    this.enabled = !!options.transactional;
  }

  private resolve(): void {
    if (this.resolved) return;
    this.resolved = true;
    if (!this.enabled) return;
    try {
      const { TransactionHost } = require('@nestjs-cls/transactional');
      this.host = this.moduleRef.get(TransactionHost, { strict: false });
    } catch {
      this.logger.warn(
        'transactional: true but @nestjs-cls/transactional is not available. '
        + 'Install @nestjs-cls/transactional and register ClsPluginTransactional to enable transaction wrapping.',
      );
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.resolve();
    return this.host ? this.host.withTransaction(fn) : fn();
  }

  get isActive(): boolean {
    this.resolve();
    return this.host !== null;
  }
}

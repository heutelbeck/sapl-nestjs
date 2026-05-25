import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { SaplConstraintHandler } from './SaplConstraintHandler';
import type { ConstraintHandlerProvider } from './api/index';

/**
 * Discovers `@SaplConstraintHandler('provider')`-decorated injectables
 * implementing `ConstraintHandlerProvider`. The planner queries the
 * registry at plan-build time.
 */
@Injectable()
export class ProviderRegistry implements OnModuleInit {
  private providers: readonly ConstraintHandlerProvider[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const wrappers = this.discovery.getProviders({ metadataKey: SaplConstraintHandler.KEY });
    const found: ConstraintHandlerProvider[] = [];
    for (const wrapper of wrappers) {
      const meta = this.discovery.getMetadataByDecorator(SaplConstraintHandler, wrapper);
      if (meta !== 'provider') continue;
      const instance = wrapper.instance as ConstraintHandlerProvider | undefined;
      if (instance && typeof instance.getHandlers === 'function') {
        found.push(instance);
      }
    }
    this.providers = found;
  }

  all(): readonly ConstraintHandlerProvider[] {
    return this.providers;
  }
}

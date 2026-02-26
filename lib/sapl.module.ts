import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AopModule } from '@toss/nestjs-aop';
import { ClsModule } from 'nestjs-cls';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions, SaplModuleAsyncOptions } from './sapl.interfaces';
import { PdpService } from './pdp.service';
import { PreEnforceAspect } from './PreEnforceAspect';
import { PostEnforceAspect } from './PostEnforceAspect';
import { EnforceTillDeniedAspect } from './EnforceTillDeniedAspect';
import { EnforceDropWhileDeniedAspect } from './EnforceDropWhileDeniedAspect';
import { EnforceRecoverableIfDeniedAspect } from './EnforceRecoverableIfDeniedAspect';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { ContentFilteringProvider } from './constraints/providers/ContentFilteringProvider';
import { ContentFilterPredicateProvider } from './constraints/providers/ContentFilterPredicateProvider';
import { SaplTransactionAdapter } from './SaplTransactionAdapter';

const SHARED_PROVIDERS = [
  PdpService,
  ConstraintEnforcementService,
  ContentFilteringProvider,
  ContentFilterPredicateProvider,
  SaplTransactionAdapter,
  PreEnforceAspect,
  PostEnforceAspect,
  EnforceTillDeniedAspect,
  EnforceDropWhileDeniedAspect,
  EnforceRecoverableIfDeniedAspect,
];

@Module({})
export class SaplModule {
  static forRoot(options: SaplModuleOptions): DynamicModule {
    return {
      module: SaplModule,
      imports: [
        DiscoveryModule,
        AopModule,
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
          ...options.cls,
        }),
      ],
      providers: [
        { provide: SAPL_MODULE_OPTIONS, useValue: options },
        ...SHARED_PROVIDERS,
      ],
      exports: [PdpService, ConstraintEnforcementService],
      global: true,
    };
  }

  // Custom CLS options (like forRoot's `cls` field) are not supported here
  // because module imports are resolved before the async factory runs. The
  // factory result (SaplModuleOptions) is not available at import time, so
  // ClsModule always gets the defaults. Users who need custom CLS setup can
  // inject ClsService in a guard or interceptor instead.
  static forRootAsync(asyncOptions: SaplModuleAsyncOptions): DynamicModule {
    return {
      module: SaplModule,
      imports: [
        DiscoveryModule,
        AopModule,
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
        }),
        ...(asyncOptions.imports ?? []),
      ],
      providers: [
        {
          provide: SAPL_MODULE_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: asyncOptions.inject ?? [],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: [PdpService, ConstraintEnforcementService],
      global: true,
    };
  }
}

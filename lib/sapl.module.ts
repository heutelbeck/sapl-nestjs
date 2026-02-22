import { DynamicModule, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions, SaplModuleAsyncOptions } from './sapl.interfaces';
import { PdpService } from './pdp.service';
import { PreEnforceInterceptor } from './PreEnforceInterceptor';
import { PostEnforceInterceptor } from './PostEnforceInterceptor';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { ContentFilteringProvider } from './constraints/providers/ContentFilteringProvider';
import { ContentFilterPredicateProvider } from './constraints/providers/ContentFilterPredicateProvider';

const SHARED_PROVIDERS = [
  PdpService,
  ConstraintEnforcementService,
  ContentFilteringProvider,
  ContentFilterPredicateProvider,
  { provide: APP_INTERCEPTOR, useClass: PreEnforceInterceptor },
  { provide: APP_INTERCEPTOR, useClass: PostEnforceInterceptor },
];

@Module({})
export class SaplModule {
  static forRoot(options: SaplModuleOptions): DynamicModule {
    return {
      module: SaplModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: SAPL_MODULE_OPTIONS, useValue: options },
        ...SHARED_PROVIDERS,
      ],
      exports: [PdpService, ConstraintEnforcementService],
      global: true,
    };
  }

  static forRootAsync(asyncOptions: SaplModuleAsyncOptions): DynamicModule {
    return {
      module: SaplModule,
      imports: [DiscoveryModule, ...(asyncOptions.imports ?? [])],
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

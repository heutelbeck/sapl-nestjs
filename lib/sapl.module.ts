import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AopModule } from '@toss/nestjs-aop';
import { ClsModule } from 'nestjs-cls';
import { SAPL_MODULE_OPTIONS } from './sapl.constants';
import { SaplModuleOptions, SaplModuleAsyncOptions } from './sapl.interfaces';
import { PdpService } from './pdp.service';
import { PreEnforceAspect } from './PreEnforceAspect';
import { PostEnforceAspect } from './PostEnforceAspect';
import { ConstraintEnforcementService } from './constraints/ConstraintEnforcementService';
import { ContentFilteringProvider } from './constraints/providers/ContentFilteringProvider';
import { ContentFilterPredicateProvider } from './constraints/providers/ContentFilterPredicateProvider';

const SHARED_PROVIDERS = [
  PdpService,
  ConstraintEnforcementService,
  ContentFilteringProvider,
  ContentFilterPredicateProvider,
  PreEnforceAspect,
  PostEnforceAspect,
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

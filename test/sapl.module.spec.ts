import { Test } from '@nestjs/testing';
import { SaplModule } from '../lib/sapl.module';
import { PdpService } from '../lib/pdp.service';
import { ConstraintEnforcementService } from '../lib/constraints/ConstraintEnforcementService';

describe('SaplModule', () => {
  test('whenForRootThenPdpServiceAndConstraintServiceResolvable', async () => {
    const module = await Test.createTestingModule({
      imports: [
        SaplModule.forRoot({ baseUrl: 'https://localhost:8443' }),
      ],
    }).compile();

    expect(module.get(PdpService)).toBeInstanceOf(PdpService);
    expect(module.get(ConstraintEnforcementService)).toBeInstanceOf(ConstraintEnforcementService);

    await module.close();
  });

  test('whenForRootAsyncWithFactoryThenPdpServiceResolvable', async () => {
    const module = await Test.createTestingModule({
      imports: [
        SaplModule.forRootAsync({
          useFactory: () => ({ baseUrl: 'https://localhost:8443', token: 'test-token' }),
        }),
      ],
    }).compile();

    expect(module.get(PdpService)).toBeInstanceOf(PdpService);
    expect(module.get(ConstraintEnforcementService)).toBeInstanceOf(ConstraintEnforcementService);

    await module.close();
  });
});

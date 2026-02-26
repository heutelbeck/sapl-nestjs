import { SaplTransactionAdapter } from '../lib/SaplTransactionAdapter';

jest.mock('@nestjs-cls/transactional', () => ({
  TransactionHost: class TransactionHost {},
}), { virtual: true });

describe('SaplTransactionAdapter', () => {
  function createAdapter(
    enabled: boolean,
    moduleRefBehavior: 'returns-host' | 'throws' = 'returns-host',
  ) {
    const mockHost = {
      withTransaction: jest.fn(async (fn: () => Promise<any>) => fn()),
    };
    const moduleRef = {
      get: jest.fn(() => {
        if (moduleRefBehavior === 'throws') throw new Error('No provider');
        return mockHost;
      }),
    };
    const adapter = new SaplTransactionAdapter(
      moduleRef as any,
      { baseUrl: 'https://localhost:8443', transactional: enabled },
    );
    return { adapter, moduleRef, mockHost };
  }

  test('whenDisabledThenDirectExecution', async () => {
    const { adapter, moduleRef } = createAdapter(false);
    const fn = jest.fn().mockResolvedValue('result');

    const result = await adapter.withTransaction(fn);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalled();
    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(adapter.isActive).toBe(false);
  });

  test('whenEnabledAndHostAvailableThenDelegatesToHost', async () => {
    const { adapter, mockHost } = createAdapter(true);
    const fn = jest.fn().mockResolvedValue('result');

    const result = await adapter.withTransaction(fn);

    expect(result).toBe('result');
    expect(mockHost.withTransaction).toHaveBeenCalledWith(fn);
    expect(adapter.isActive).toBe(true);
  });

  test('whenEnabledAndHostNotAvailableThenDirectExecutionWithWarning', async () => {
    const { adapter } = createAdapter(true, 'throws');
    const fn = jest.fn().mockResolvedValue('fallback');

    const result = await adapter.withTransaction(fn);

    expect(result).toBe('fallback');
    expect(fn).toHaveBeenCalled();
    expect(adapter.isActive).toBe(false);
  });

  test('whenFnThrowsThenErrorPropagates', async () => {
    const { adapter } = createAdapter(false);
    const error = new Error('boom');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(adapter.withTransaction(fn)).rejects.toBe(error);
  });

  test('whenCalledMultipleTimesThenResolvesOnce', async () => {
    const { adapter, moduleRef } = createAdapter(true);
    const fn = jest.fn().mockResolvedValue('ok');

    await adapter.withTransaction(fn);
    await adapter.withTransaction(fn);
    await adapter.withTransaction(fn);

    expect(moduleRef.get).toHaveBeenCalledTimes(1);
  });
});

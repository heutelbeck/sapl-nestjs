import { logReconnectAttempt } from '../../lib/transport/HttpPdpClient';

describe('logReconnectAttempt', () => {
  const makeLogger = () => ({ warn: jest.fn(), error: jest.fn() });

  it.each([1, 2, 3, 4])('warns and does not error on early reconnect attempt %i', (attempt) => {
    const logger = makeLogger();
    logReconnectAttempt(logger, attempt, 'reconnecting');
    expect(logger.warn).toHaveBeenCalledWith('reconnecting');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([5, 6, 25])('escalates to error and does not warn from reconnect attempt %i', (attempt) => {
    const logger = makeLogger();
    logReconnectAttempt(logger, attempt, 'reconnecting');
    expect(logger.error).toHaveBeenCalledWith('reconnecting');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

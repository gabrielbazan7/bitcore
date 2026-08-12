'use strict';

import { expect } from 'chai';
import sinon from 'sinon';
import { logger } from '../src/lib/logger';
import { registerWebhookRoutes } from '../src/lib/routes/webhooks';
import { OnrampWebhookEvent } from '../src/lib/model/onrampWebhookEvent';

function moonpayEvent(): OnrampWebhookEvent {
  return OnrampWebhookEvent.create({
    partner: 'moonpay',
    env: 'sandbox',
    eventName: 'transaction_updated',
    externalId: 'moonpay-transaction-1',
    externalTransactionId: 'wallet-1-1723381200000',
    status: 'completed',
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:05:00.000Z',
    userId: 'braze-user-1',
    rawPayload: { data: { id: 'moonpay-transaction-1' } }
  });
}

function retryableError(message: string): Error {
  const err: any = new Error(message);
  err.retryable = true;
  return err;
}

function routeWithMoonpayStubs(
  parseEvent: sinon.SinonStub,
  processEvent: sinon.SinonStub,
  path = '/v1/service/moonpay/webhook'
) {
  const server = {
    externalServices: {
      moonpay: {
        moonpayHandleWebhook: parseEvent
      }
    },
    onrampWebhookProcessor: {
      processMoonpay: processEvent
    }
  };
  let routeHandler;
  const router = {
    post: (registeredPath: string, handler) => {
      if (registeredPath === path) routeHandler = handler;
    }
  };
  registerWebhookRoutes(router, {
    getServer: () => server,
    returnError: sinon.stub()
  } as any);
  if (!routeHandler) throw new Error(`MoonPay webhook route ${path} was not registered`);

  return async () => {
    const response = {
      statusCode: 0,
      body: undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      }
    };
    await routeHandler({ body: { type: 'transaction_updated' } }, response);
    return response;
  };
}

describe('MoonPay webhook HTTP route', () => {
  beforeEach(() => {
    sinon.stub(logger, 'error');
    sinon.stub(logger, 'info');
  });

  afterEach(() => sinon.restore());

  for (const invalidInput of [
    {
      name: 'signature',
      error: new Error('MoonPay webhook signature verification failed')
    },
    {
      name: 'payload',
      error: new Error('MoonPay webhook missing transaction id')
    }
  ]) {
    it(`returns 400 for an invalid ${invalidInput.name}`, async () => {
      const parseEvent = sinon.stub().throws(invalidInput.error);
      const processEvent = sinon.stub().resolves();
      const invokeRoute = routeWithMoonpayStubs(parseEvent, processEvent);

      const response = await invokeRoute();

      expect(response.statusCode).to.equal(400);
      expect(response.body).to.deep.equal({ error: invalidInput.error.message });
      sinon.assert.calledOnce(parseEvent);
      sinon.assert.notCalled(processEvent);
    });
  }

  for (const retryableFailure of [
    retryableError('MoonPay webhook API key is not configured'),
    retryableError('MoonPay webhook raw body is unavailable')
  ]) {
    it(`returns 503 for retryable parsing failure: ${retryableFailure.message}`, async () => {
      const parseEvent = sinon.stub().throws(retryableFailure);
      const processEvent = sinon.stub().resolves();
      const invokeRoute = routeWithMoonpayStubs(parseEvent, processEvent);

      const response = await invokeRoute();

      expect(response.statusCode).to.equal(503);
      expect(response.body).to.deep.equal({ error: retryableFailure.message });
      sinon.assert.calledOnce(parseEvent);
      sinon.assert.notCalled(processEvent);
    });
  }

  it('returns 200 after the processor succeeds', async () => {
    const event = moonpayEvent();
    const parseEvent = sinon.stub().returns({ event });
    const processEvent = sinon.stub().resolves({ deliveryInserted: true, action: 'sent' });
    const invokeRoute = routeWithMoonpayStubs(parseEvent, processEvent);

    const response = await invokeRoute();

    expect(response.statusCode).to.equal(200);
    expect(response.body).to.deep.equal({ ok: true });
    sinon.assert.calledOnce(parseEvent);
    sinon.assert.calledOnceWithExactly(processEvent, event);
  });

  for (const dependency of ['storage', 'Braze']) {
    it(`returns 503 when ${dependency} rejects during processing`, async () => {
      const event = moonpayEvent();
      const parseEvent = sinon.stub().returns({ event });
      const processEvent = sinon.stub().rejects(new Error(`${dependency} unavailable`));
      const invokeRoute = routeWithMoonpayStubs(parseEvent, processEvent);

      const response = await invokeRoute();

      expect(response.statusCode).to.equal(503);
      expect(response.body).to.deep.equal({ error: 'Webhook processing temporarily unavailable' });
      sinon.assert.calledOnce(parseEvent);
      sinon.assert.calledOnceWithExactly(processEvent, event);
    });
  }
});

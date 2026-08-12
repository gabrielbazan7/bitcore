'use strict';

import { expect } from 'chai';
import sinon from 'sinon';
import type { BrazeCustomEvent, BrazeTrackResponse } from '../src/externalservices/braze';
import { OnrampWebhookProcessor } from '../src/lib/onrampwebhookprocessor';
import {
  IClaimOnrampWebhookActionResult,
  IOnrampWebhookAction,
  IStoreOnrampWebhookEventResult
} from '../src/lib/model/onrampWebhookAction';
import { OnrampWebhookEvent } from '../src/lib/model/onrampWebhookEvent';
import { Storage } from '../src/lib/storage';

const successfulBrazeResponse: BrazeTrackResponse = {
  message: 'success',
  events_processed: 1
};

class InMemoryOnrampStorage {
  deliveries = new Map<string, IStoreOnrampWebhookEventResult>();
  actions = new Map<string, IOnrampWebhookAction>();
  failedMarks = 0;
  processedMarks = 0;

  private leaseSequence = 0;

  async storeOnrampWebhookEvent({ event }: { event: OnrampWebhookEvent }): Promise<IStoreOnrampWebhookEventResult> {
    const id = [event.partner, event.env, event.eventName, event.externalId, event.updatedAt].join(':');
    const existing = this.deliveries.get(id);
    if (existing) {
      return { ...existing, inserted: false };
    }

    const storedEvent: any = { ...event, _id: id };
    delete storedEvent.rawPayload;
    const result = { inserted: true, id, event: storedEvent };
    this.deliveries.set(id, result);
    return result;
  }

  async claimOnrampWebhookAction(opts: {
    provider: string;
    env: string;
    action: string;
    transactionId: string;
    payload?: object;
  }): Promise<IClaimOnrampWebhookActionResult> {
    const id = [opts.provider, opts.env, opts.action, opts.transactionId].join(':');
    const existing = this.actions.get(id);
    if (existing && existing.status !== 'failed') {
      return { claimed: false, action: existing };
    }

    this.leaseSequence += 1;
    const now = Date.now();
    const action: IOnrampWebhookAction = {
      _id: id,
      provider: opts.provider,
      env: opts.env,
      action: opts.action,
      transactionId: opts.transactionId,
      status: 'processing',
      attempts: (existing?.attempts || 0) + 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      payload: opts.payload,
      leaseId: `lease-${this.leaseSequence}`,
      processingStartedAt: now,
      leaseExpiresAt: now + 30_000
    };
    this.actions.set(id, action);
    return { claimed: true, action };
  }

  async markOnrampWebhookActionProcessed(opts: {
    id: string;
    leaseId: string;
    result?: object;
  }): Promise<IOnrampWebhookAction | null> {
    const action = this.actions.get(opts.id);
    if (!action || action.status !== 'processing' || action.leaseId !== opts.leaseId) return null;

    this.processedMarks += 1;
    action.status = 'processed';
    action.result = opts.result;
    action.processedAt = Date.now();
    delete action.leaseId;
    delete action.processingStartedAt;
    delete action.leaseExpiresAt;
    return action;
  }

  async markOnrampWebhookActionFailed(opts: {
    id: string;
    leaseId: string;
    error: string;
  }): Promise<IOnrampWebhookAction | null> {
    const action = this.actions.get(opts.id);
    if (!action || action.status !== 'processing' || action.leaseId !== opts.leaseId) return null;

    this.failedMarks += 1;
    action.status = 'failed';
    action.lastError = opts.error;
    action.failedAt = Date.now();
    delete action.leaseId;
    delete action.processingStartedAt;
    delete action.leaseExpiresAt;
    return action;
  }
}

function moonpayEvent(overrides: Partial<OnrampWebhookEvent> = {}): OnrampWebhookEvent {
  return OnrampWebhookEvent.create({
    partner: 'moonpay',
    env: 'sandbox',
    eventName: 'transaction_updated',
    externalId: 'moonpay-transaction-1',
    externalTransactionId: 'wallet-1-1723381200000',
    status: 'completed',
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:05:00.000Z',
    receivedAt: 1_723_381_500_000,
    userId: 'braze-user-1',
    fiatAmount: 100,
    feeAmount: 4,
    extraFeeAmount: 2.5,
    networkFeeAmount: 1,
    fiatCurrency: 'USD',
    cryptoAmount: 0.0015,
    cryptoCurrency: 'BTC',
    exchangeRate: 66_666.67,
    chain: 'bitcoin',
    paymentMethod: 'credit_debit_card',
    isEmbedded: true,
    rawPayload: { data: { id: 'moonpay-transaction-1' } },
    ...overrides
  });
}

function processorWith(
  storage: InMemoryOnrampStorage,
  logCustomEvent: (event: BrazeCustomEvent) => Promise<BrazeTrackResponse>
): OnrampWebhookProcessor {
  return new OnrampWebhookProcessor(
    storage as unknown as Storage,
    () => ({ logCustomEvent })
  );
}

async function expectError(promise: Promise<unknown>, message: string): Promise<Error> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (err) {
    expect(err).to.be.instanceOf(Error);
    expect((err as Error).message).to.equal(message);
    return err as Error;
  }
}

describe('OnrampWebhookProcessor', () => {
  afterEach(() => sinon.restore());

  it('stores but skips MoonPay deliveries that are not completed buys', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    const created = await processor.processMoonpay(moonpayEvent({
      eventName: 'transaction_created',
      status: 'waitingPayment',
      updatedAt: '2026-08-11T12:01:00.000Z'
    }));
    const pending = await processor.processMoonpay(moonpayEvent({ status: 'pending' }));

    expect(created).to.deep.equal({
      deliveryInserted: true,
      action: 'skipped',
      reason: 'not-completed-buy'
    });
    expect(pending).to.deep.equal({
      deliveryInserted: true,
      action: 'skipped',
      reason: 'not-completed-buy'
    });
    expect(storage.deliveries.size).to.equal(2);
    expect(storage.actions.size).to.equal(0);
    sinon.assert.notCalled(logCustomEvent);
  });

  it('sends the exact existing purchase event for a completed MoonPay buy', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    const result = await processor.processMoonpay(moonpayEvent());

    expect(result).to.deep.equal({ deliveryInserted: true, action: 'sent' });
    sinon.assert.calledOnceWithExactly(logCustomEvent, {
      externalId: 'braze-user-1',
      name: 'BitPay App - Webhook - Purchased Buy Crypto',
      time: '2026-08-11T12:05:00.000Z',
      properties: {
        exchange: 'moonpay',
        fiatAmount: 107.5,
        feeAmount: 7.5,
        fiatCurrency: 'USD',
        coin: 'btc',
        chain: 'bitcoin',
        cryptoAmount: 0.0015,
        paymentMethod: 'credit_debit_card',
        exchangeRate: 66_666.67,
        isEmbedded: true,
        source: 'moonpay_webhook'
      }
    });
    expect(storage.processedMarks).to.equal(1);
    expect(Array.from(storage.actions.values())[0].result).to.deep.equal({
      message: 'success',
      eventsProcessed: 1
    });
  });

  it('reports the total paid and the combined fees like the app does', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    // 49.99 + 3.33 + 1.11 would be 54.42999999999999 without rounding to cents.
    await processor.processMoonpay(moonpayEvent({
      fiatAmount: 49.99,
      feeAmount: 3.33,
      extraFeeAmount: undefined,
      networkFeeAmount: 1.11
    }));

    const { properties } = logCustomEvent.firstCall.args[0];
    expect(properties.feeAmount).to.equal(4.44);
    expect(properties.fiatAmount).to.equal(54.43);
  });

  it('omits fiat amounts entirely when MoonPay sends none instead of sending empty strings', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    await processor.processMoonpay(moonpayEvent({
      fiatAmount: undefined,
      feeAmount: undefined,
      extraFeeAmount: undefined,
      networkFeeAmount: undefined
    }));

    const { properties } = logCustomEvent.firstCall.args[0];
    expect(properties).to.not.have.property('fiatAmount');
    expect(properties).to.not.have.property('feeAmount');
  });

  it('stores but skips a completed buy without a Braze user id', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    const result = await processor.processMoonpay(moonpayEvent({ userId: undefined }));

    expect(result).to.deep.equal({
      deliveryInserted: true,
      action: 'skipped',
      reason: 'missing-user-id'
    });
    expect(storage.deliveries.size).to.equal(1);
    expect(storage.actions.size).to.equal(0);
    sinon.assert.notCalled(logCustomEvent);
  });

  it('does not send a processed action again for the same delivery', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    const first = await processor.processMoonpay(moonpayEvent());
    const duplicate = await processor.processMoonpay(moonpayEvent());

    expect(first.action).to.equal('sent');
    expect(duplicate).to.deep.equal({ deliveryInserted: false, action: 'duplicate' });
    sinon.assert.calledOnce(logCustomEvent);
    expect(storage.processedMarks).to.equal(1);
  });

  it('rejects a concurrent attempt so the webhook route can return a retryable response', async () => {
    const storage = new InMemoryOnrampStorage();
    let resolveBraze: (result: BrazeTrackResponse) => void;
    const brazePending = new Promise<BrazeTrackResponse>(resolve => {
      resolveBraze = resolve;
    });
    const logCustomEvent = sinon.stub().returns(brazePending);
    const processor = processorWith(storage, logCustomEvent);

    const firstAttempt = processor.processMoonpay(moonpayEvent());
    while (!logCustomEvent.called) await Promise.resolve();

    await expectError(
      processor.processMoonpay(moonpayEvent()),
      'MoonPay webhook action moonpay:sandbox:braze-purchased-buy-crypto:moonpay-transaction-1 is already processing'
    );

    resolveBraze!(successfulBrazeResponse);
    expect((await firstAttempt).action).to.equal('sent');
    sinon.assert.calledOnce(logCustomEvent);
  });

  it('marks the action failed when Braze rejects it', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().rejects(new Error('Braze unavailable'));
    const processor = processorWith(storage, logCustomEvent);

    await expectError(processor.processMoonpay(moonpayEvent()), 'Braze unavailable');

    const action = Array.from(storage.actions.values())[0];
    expect(action.status).to.equal('failed');
    expect(action.lastError).to.equal('Braze unavailable');
    expect(storage.failedMarks).to.equal(1);
    expect(storage.processedMarks).to.equal(0);
  });

  it('reclaims a failed action and eventually marks it processed', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub();
    logCustomEvent.onFirstCall().rejects(new Error('temporary Braze error'));
    logCustomEvent.onSecondCall().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    await expectError(processor.processMoonpay(moonpayEvent()), 'temporary Braze error');
    const retry = await processor.processMoonpay(moonpayEvent());

    expect(retry).to.deep.equal({ deliveryInserted: false, action: 'sent' });
    const action = Array.from(storage.actions.values())[0];
    expect(action.status).to.equal('processed');
    expect(action.attempts).to.equal(2);
    expect(storage.failedMarks).to.equal(1);
    expect(storage.processedMarks).to.equal(1);
    sinon.assert.calledTwice(logCustomEvent);
  });

  it('stores distinct completed updates but sends only one business action per transaction', async () => {
    const storage = new InMemoryOnrampStorage();
    const logCustomEvent = sinon.stub().resolves(successfulBrazeResponse);
    const processor = processorWith(storage, logCustomEvent);

    const first = await processor.processMoonpay(moonpayEvent());
    const laterUpdate = await processor.processMoonpay(moonpayEvent({
      updatedAt: '2026-08-11T12:06:00.000Z'
    }));

    expect(first).to.deep.equal({ deliveryInserted: true, action: 'sent' });
    expect(laterUpdate).to.deep.equal({ deliveryInserted: true, action: 'duplicate' });
    expect(storage.deliveries.size).to.equal(2);
    expect(storage.actions.size).to.equal(1);
    sinon.assert.calledOnce(logCustomEvent);
  });
});

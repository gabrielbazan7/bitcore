'use strict';

import { expect } from 'chai';
import sinon from 'sinon';
import {
  BrazeService,
  BrazeServiceError,
  type BrazeServiceOptions
} from '../../../src/externalservices/braze';

const defaultOptions: BrazeServiceOptions = {
  apiUrl: 'https://rest.example.braze.com/',
  apiKey: 'users-track-api-key',
  appId: 'app-id'
};

const successfulResponse = {
  statusCode: 201,
  body: {
    message: 'success',
    events_processed: 1
  }
};

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

describe('BrazeService', () => {
  afterEach(() => sinon.restore());

  it('posts a custom event with the expected identity, auth, timeout and update-only behavior', async () => {
    const service = new BrazeService(defaultOptions);
    const post = sinon.stub().callsFake((_url, _opts, cb) => cb(null, successfulResponse));
    service.request = { post };

    const response = await service.logCustomEvent({
      externalId: ' user-eid ',
      name: ' BitPay App - Purchased Buy Crypto ',
      time: '2026-08-11T12:34:56.000Z',
      properties: {
        source: 'moonpay_webhook',
        fiatAmount: 100,
        completed: true
      }
    });

    expect(response).to.deep.equal(successfulResponse.body);
    sinon.assert.calledOnce(post);

    const [url, opts] = post.firstCall.args;
    expect(url).to.equal('https://rest.example.braze.com/users/track');
    expect(opts.timeout).to.equal(3000);
    expect(opts.headers).to.deep.equal({
      Accept: 'application/json',
      Authorization: 'Bearer users-track-api-key',
      'Content-Type': 'application/json'
    });
    expect(opts.body).to.deep.equal({
      events: [
        {
          external_id: 'user-eid',
          app_id: 'app-id',
          name: 'BitPay App - Purchased Buy Crypto',
          time: '2026-08-11T12:34:56.000Z',
          properties: {
            source: 'moonpay_webhook',
            fiatAmount: 100,
            completed: true
          },
          _update_existing_only: true
        }
      ]
    });
  });

  it('supports an omitted app id and a custom timeout', async () => {
    const service = new BrazeService({
      apiUrl: 'https://rest.example.braze.com',
      apiKey: 'api-key',
      timeout: 4500
    });
    const post = sinon.stub().callsFake((_url, _opts, cb) => cb(null, successfulResponse));
    service.request = { post };

    await service.logCustomEvent({
      externalId: 'user-eid',
      name: 'event',
      time: new Date('2026-08-11T00:00:00.000Z')
    });

    const opts = post.firstCall.args[1];
    expect(opts.timeout).to.equal(4500);
    expect(opts.body.events[0]).not.to.have.property('app_id');
    expect(opts.body.events[0]).not.to.have.property('properties');
  });

  it('uses the callback body returned by request', async () => {
    const service = new BrazeService(defaultOptions);
    const body = { message: 'success', events_processed: 1 };
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) => cb(null, { statusCode: 200 }, body))
    };

    expect(await service.logCustomEvent({ externalId: 'eid', name: 'event' })).to.equal(body);
  });

  it('rejects transport errors', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) => cb(new Error('network unavailable')))
    };

    const err = await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze request failed'
    );
    expect(err).to.be.instanceOf(BrazeServiceError);
  });

  it('rejects non-2xx responses even if the body says success', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) =>
        cb(null, { statusCode: 429, body: { message: 'success', events_processed: 1 } })
      )
    };

    const err = await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze request failed'
    ) as BrazeServiceError;
    expect(err.statusCode).to.equal(429);
  });

  it('rejects unsuccessful response bodies', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) =>
        cb(null, { statusCode: 200, body: { message: 'error', events_processed: 0 } })
      )
    };

    await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze returned an unsuccessful response: error'
    );
  });

  it('surfaces why Braze rejected the request while redacting the api key it echoes back', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) =>
        cb(null, { statusCode: 401, body: { message: `Invalid API key: ${defaultOptions.apiKey}` } })
      )
    };

    const err = await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze request failed: Invalid API key: [redacted]'
    ) as BrazeServiceError;
    expect(err.statusCode).to.equal(401);
    expect(err.message).to.not.contain(defaultOptions.apiKey);
  });

  it('rejects responses with event errors', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) =>
        cb(null, {
          statusCode: 200,
          body: { message: 'success', events_processed: 1, errors: [{ type: 'invalid' }] }
        })
      )
    };

    await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze returned event errors: [{"type":"invalid"}]'
    );
  });

  it('rejects responses that did not process exactly one event', async () => {
    const service = new BrazeService(defaultOptions);
    service.request = {
      post: sinon.stub().callsFake((_url, _opts, cb) =>
        cb(null, { statusCode: 200, body: { message: 'success', events_processed: 0 } })
      )
    };

    await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze did not process the event'
    );
  });

  it('defers missing config errors until delivery so callers can return a retryable webhook response', async () => {
    await expectError(
      new BrazeService().logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze missing credentials'
    );
    await expectError(
      new BrazeService({ apiUrl: 'https://rest.example.braze.com', apiKey: '' })
        .logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze missing credentials'
    );
  });

  it('keeps configured timeouts below the webhook deadline', async () => {
    await expectError(
      new BrazeService({
        apiUrl: 'https://rest.example.braze.com',
        apiKey: 'api-key',
        timeout: 5000
      }).logCustomEvent({ externalId: 'eid', name: 'event' }),
      'Braze timeout must be an integer below 5000ms'
    );
  });

  it('validates event identity and timestamp before making a request', async () => {
    const service = new BrazeService(defaultOptions);
    const post = sinon.stub();
    service.request = { post };

    await expectError(
      service.logCustomEvent({ externalId: '', name: 'event' }),
      'Braze custom event requires externalId and name'
    );
    await expectError(
      service.logCustomEvent({ externalId: 'eid', name: 'event', time: 'not-a-date' }),
      'Braze custom event has an invalid time'
    );
    sinon.assert.notCalled(post);
  });
});

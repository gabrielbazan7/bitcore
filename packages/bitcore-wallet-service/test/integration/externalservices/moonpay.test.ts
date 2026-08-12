'use strict';

import * as chai from 'chai';
import 'chai/register-should';
import * as crypto from 'crypto';
import util from 'util';
import { MoonpayService } from '../../../src/externalservices/moonpay';
import { WalletService } from '../../../src/lib/server';
import * as TestData from '../../testdata';
import helpers from '../helpers';
import config from '../../../src/config';

const should = chai.should();

describe('Moonpay integration', () => {
  let server;
  let wallet;
  let fakeRequest;
  let req;

  before(async () => {
    await helpers.before();
  });

  beforeEach(async () => {
    config.moonpay = {
      sandbox: {
        apiKey: 'apiKey1',
        api: 'api1',
        widgetApi: 'widgetApi1',
        sellWidgetApi: 'sellWidgetApi1',
        secretKey: 'secretKey1'
      },
      production: {
        apiKey: 'apiKey2',
        api: 'api2',
        widgetApi: 'widgetApi2',
        sellWidgetApi: 'sellWidgetApi2',
        secretKey: 'secretKey2'
      },
      sandboxWeb: {
        apiKey: 'apiKey3',
        api: 'api3',
        widgetApi: 'widgetApi3',
        sellWidgetApi: 'sellWidgetApi3',
        secretKey: 'secretKey3'
      },
      productionWeb: {
        apiKey: 'apiKey4',
        api: 'api4',
        widgetApi: 'widgetApi4',
        sellWidgetApi: 'sellWidgetApi4',
        secretKey: 'secretKey4'
      }
    };

    fakeRequest = {
      get: (_url, _opts, _cb) => { return _cb(null, { body: 'data' }); },
      post: (_url, _opts, _cb) => { return _cb(null, { body: 'data' }); },
      delete: (_url, _opts, _cb) => { return _cb(null, { body: 'data' }); },
    };

    await helpers.beforeEach();
    ({ wallet } = await helpers.createAndJoinWallet(1, 1));
    const priv = TestData.copayers[0].privKey_1H_0;
    const sig = helpers.signMessage('hello world', priv);
  
    (server = await util.promisify(WalletService.getInstanceWithAuth).call(WalletService, {
      // test assumes wallet's copayer[0] is TestData's copayer[0]
      copayerId: wallet.copayers[0].id,
      message: 'hello world',
      signature: sig,
      clientVersion: 'bwc-2.0.0',
      walletId: '123',
    }));
  });

  after(async () => {
    await helpers.after();
  });

  describe('#moonpayGetQuote', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          currencyAbbreviation: 'btc',
          baseCurrencyAmount: 50,
          extraFeePercentage: 5,
          baseCurrencyCode: 'usd'
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      const data = await server.externalServices.moonpay.moonpayGetQuote(req);
      should.exist(data);
    });

    it('should work properly if req is OK for web', async () => {
      req.body.context = 'web';
      const data = await server.externalServices.moonpay.moonpayGetQuote(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is some missing arguments', async () => {
      delete req.body.baseCurrencyAmount;
      try {
        await server.externalServices.moonpay.moonpayGetQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetSellQuote', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          currencyAbbreviation: 'btc',
          quoteCurrencyCode: 'usd',
          baseCurrencyAmount: 1
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      const data = await server.externalServices.moonpay.moonpayGetSellQuote(req);
      should.exist(data);
    });

    it('should work properly if req is OK for web', async () => {
      req.body.context = 'web';
      const data = await server.externalServices.moonpay.moonpayGetSellQuote(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetSellQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      };
    });

    it('should return error if there is some missing arguments', async () => {
      delete req.body.baseCurrencyAmount;
      try {
        await server.externalServices.moonpay.moonpayGetSellQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetSellQuote(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetCurrencyLimits', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          currencyAbbreviation: 'btc',
          baseCurrencyCode: 'usd'
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      const data = await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
      should.exist(data);
    });

    it('should work properly if req is OK for web', async () => {
      req.body.context = 'web';
      const data = await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      };
    });

    it('should return error if there is some missing arguments', async () => {
      delete req.body.baseCurrencyCode;
      try {
        await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetCurrencyLimits(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetSignedPaymentUrl', () => {
    beforeEach(() => {
      req = {
        headers: {
          'x-forwarded-for': '1.2.3.4'
        },
        body: {
          env: 'production',
          currencyCode: 'btc',
          walletAddress: 'bitcoin:123123',
          baseCurrencyCode: 'usd',
          baseCurrencyAmount: '500',
          externalTransactionId: '123123',
          redirectURL: 'bitpay://moonpay'
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should get the paymentUrl properly if req is OK', () => {
      const data = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('widgetApi2?apiKey=apiKey2&currencyCode=btc&walletAddress=bitcoin%3A123123&baseCurrencyCode=usd&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&allowedIpAddress=CN35SFB5PKS4vkiZ4CglTxRgTAaUHBLGZcenAw6gHEY%3D&signature=3XxjRX3EMj2RNaoAwgOwFBOiVTXsgAS7C50uJf9SsvM%3D');
    });

    it('should return error if request does not have IP', () => {
      delete req.headers['x-forwarded-for'];
      try {
        server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Could not determine device IP address');
      }
    });

    it('should hash the forwarded deviceIp instead of the request IP for web context', () => {
      req.body.context = 'web';
      req.body.deviceIp = '203.0.113.42';
      const data = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('widgetApi4?apiKey=apiKey4&currencyCode=btc&walletAddress=bitcoin%3A123123&baseCurrencyCode=usd&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&allowedIpAddress=HkPyqsZMUzAgsEx27Tlz%2B5XfZHaH0fSfWV%2FMKR7JAPc%3D&signature=B%2Bw0TTQiy8%2Ffq6QeoeSf4dKpdPHZ%2F2EnBB1S4UotNGM%3D');
    });

    it('should canonicalize IPv4-mapped IPv6 deviceIp before hashing', () => {
      req.body.context = 'web';
      req.body.deviceIp = '::ffff:203.0.113.42';
      const data = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('widgetApi4?apiKey=apiKey4&currencyCode=btc&walletAddress=bitcoin%3A123123&baseCurrencyCode=usd&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&allowedIpAddress=HkPyqsZMUzAgsEx27Tlz%2B5XfZHaH0fSfWV%2FMKR7JAPc%3D&signature=B%2Bw0TTQiy8%2Ffq6QeoeSf4dKpdPHZ%2F2EnBB1S4UotNGM%3D');
    });

    it('should omit allowedIpAddress for web context when no deviceIp is forwarded', () => {
      req.body.context = 'web';
      const data = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('widgetApi4?apiKey=apiKey4&currencyCode=btc&walletAddress=bitcoin%3A123123&baseCurrencyCode=usd&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&signature=13Q%2BET1UQLnCqCyg3stDAN4%2FTQ8QB009LcuAP1y6B%2FI%3D');
    });

    it('should ignore a body deviceIp for non-web context and use the request IP', () => {
      req.body.deviceIp = '203.0.113.42';
      const data = server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('widgetApi2?apiKey=apiKey2&currencyCode=btc&walletAddress=bitcoin%3A123123&baseCurrencyCode=usd&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&allowedIpAddress=CN35SFB5PKS4vkiZ4CglTxRgTAaUHBLGZcenAw6gHEY%3D&signature=3XxjRX3EMj2RNaoAwgOwFBOiVTXsgAS7C50uJf9SsvM%3D');
    });

    it('should return error if there is some missing arguments', () => {
      delete req.body.currencyCode;
      try {
        server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', () => {
      config.moonpay = undefined;
      try {
        server.externalServices.moonpay.moonpayGetSignedPaymentUrl(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetSellSignedPaymentUrl', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'production',
          baseCurrencyCode: 'btc',
          baseCurrencyAmount: 500,
          externalTransactionId: '123123',
          redirectURL: 'bitpay://moonpay',
          quoteCurrencyCode: 'usd',
          refundWalletAddress: 'bitcoin:123123',
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should get the paymentUrl properly if req is OK', () => {
      const data = server.externalServices.moonpay.moonpayGetSellSignedPaymentUrl(req);
      should.exist(data.urlWithSignature);
      data.urlWithSignature.should.equal('sellWidgetApi2?apiKey=apiKey2&baseCurrencyCode=btc&baseCurrencyAmount=500&externalTransactionId=123123&redirectURL=bitpay%3A%2F%2Fmoonpay&quoteCurrencyCode=usd&refundWalletAddress=bitcoin%3A123123&signature=otiVaKVxKT%2BRNOfkSMOk07U3JxY4DrpPAztiXl5Wvjc%3D');
    });

    it('should return error if there is some missing arguments', () => {
      delete req.body.baseCurrencyCode;

      try {
        server.externalServices.moonpay.moonpayGetSellSignedPaymentUrl(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', () => {
      config.moonpay = undefined;
      try {
        server.externalServices.moonpay.moonpayGetSellSignedPaymentUrl(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetTransactionDetails', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          transactionId: 'transactionId1',
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK with transactionId', async () => {
      const data = await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
      should.exist(data);
    });

    it('should work properly if req is OK with externalId', async () => {
      delete req.body.transactionId;
      req.body.externalId = 'externalId1';
      const data = await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is no transactionId or externalId', async () => {
      delete req.body.transactionId;
      delete req.body.externalId;
      try {
        await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetSellTransactionDetails', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          transactionId: 'transactionId1',
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK with transactionId', async () => {
      const data = await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
      should.exist(data);
    });

    it('should work properly if req is OK with externalId', async () => {
      delete req.body.transactionId;
      req.body.externalId = 'externalId1';
      const data = await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is no transactionId or externalId', async () => {
      delete req.body.transactionId;
      delete req.body.externalId;
      try {
        await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetSellTransactionDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayGetAccountDetails', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      const data = await server.externalServices.moonpay.moonpayGetAccountDetails(req);
      should.exist(data);
    });

    it('should return error if get returns error', async () => {
      const fakeRequest2 = {
        get: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayGetAccountDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayGetAccountDetails(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayCancelSellTransaction', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          transactionId: 'transactionId1',
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK with transactionId', async () => {
      const data = await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
      should.exist(data);
    });

    it('should work properly if req is OK with externalId', async () => {
      delete req.body.transactionId;
      req.body.externalId = 'externalId1';
      const data = await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
      should.exist(data);
    });

    it('should return error if delete returns error', async () => {
      const fakeRequest2 = {
        delete: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is no transactionId or externalId', async () => {
      delete req.body.transactionId;
      delete req.body.externalId;
      try {
        await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayCancelSellTransaction(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayCreateSession', () => {
    beforeEach(() => {
      req = {
        headers: {
          'x-forwarded-for': '192.168.1.1'
        },
        body: {
          env: 'sandbox',
          externalCustomerId: 'externalCustomerId1'
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      const data = await server.externalServices.moonpay.moonpayCreateSession(req);
      should.exist(data);
    });

    it('should work properly if req is OK for web', async () => {
      req.body.context = 'web';
      const data = await server.externalServices.moonpay.moonpayCreateSession(req);
      should.exist(data);
    });

    it('should work properly with optional email and phoneNumber', async () => {
      req.body.email = 'user@example.com';
      req.body.phoneNumber = '+14155551234';
      const data = await server.externalServices.moonpay.moonpayCreateSession(req);
      should.exist(data);
    });

    it('should return error if post returns error', async () => {
      const fakeRequest2 = {
        post: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayCreateSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is some missing arguments', async () => {
      delete req.body.externalCustomerId;
      try {
        await server.externalServices.moonpay.moonpayCreateSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if device IP cannot be determined', async () => {
      req.headers = {};
      delete req.ip;
      delete req.connection;
      try {
        await server.externalServices.moonpay.moonpayCreateSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Could not determine device IP address');
      }
    });

    it('should extract IP from x-forwarded-for header', async () => {
      req.headers = { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' };
      let capturedBody;
      const fakeRequest2 = {
        post: (_url, _opts, _cb) => {
          capturedBody = _opts.body;
          return _cb(null, { body: { sessionToken: 'token123' } });
        },
      };
      server.externalServices.moonpay.request = fakeRequest2;
      await server.externalServices.moonpay.moonpayCreateSession(req);
      capturedBody.deviceIp.should.equal('10.0.0.1');
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayCreateSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

  describe('#moonpayRevokeActiveSession', () => {
    beforeEach(() => {
      req = {
        headers: {},
        body: {
          env: 'sandbox',
          externalCustomerId: 'externalCustomerId1'
        }
      };
      server.externalServices.moonpay.request = fakeRequest;
    });

    it('should work properly if req is OK', async () => {
      await server.externalServices.moonpay.moonpayRevokeActiveSession(req);
    });

    it('should work properly if req is OK for web', async () => {
      req.body.context = 'web';
      await server.externalServices.moonpay.moonpayRevokeActiveSession(req);
    });

    it('should return error if delete returns error', async () => {
      const fakeRequest2 = {
        delete: (_url, _opts, _cb) => { return _cb(new Error('Error'), null); },
      };

      server.externalServices.moonpay.request = fakeRequest2;
      try {
        await server.externalServices.moonpay.moonpayRevokeActiveSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Error');
      }
    });

    it('should return error if there is some missing arguments', async () => {
      delete req.body.externalCustomerId;
      try {
        await server.externalServices.moonpay.moonpayRevokeActiveSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay\'s request missing arguments');
      }
    });

    it('should return error if moonpay is commented in config', async () => {
      config.moonpay = undefined;
      try {
        await server.externalServices.moonpay.moonpayRevokeActiveSession(req);
        should.fail('should have thrown');
      } catch (err) {
        err.message.should.equal('Moonpay missing credentials');
      }
    });
  });

});

describe('Moonpay focused signing and webhook handling', () => {
  let moonpay: MoonpayService;

  beforeEach(() => {
    config.moonpay = {
      sandbox: {
        apiKey: 'apiKey1',
        api: 'api1',
        widgetApi: 'widgetApi1',
        sellWidgetApi: 'sellWidgetApi1',
        secretKey: 'secretKey1',
        webhookApiKey: 'sandboxWebhookApiKey'
      },
      production: {
        apiKey: 'apiKey2',
        api: 'api2',
        widgetApi: 'widgetApi2',
        sellWidgetApi: 'sellWidgetApi2',
        secretKey: 'secretKey2',
        webhookApiKey: 'productionWebhookApiKey'
      }
    };
    moonpay = new MoonpayService();
  });

  it('should include externalCustomerId in the signed payment URL', () => {
    const req = {
      headers: {
        'x-forwarded-for': '1.2.3.4'
      },
      body: {
        env: 'production',
        currencyCode: 'btc',
        walletAddress: 'bitcoin:123123',
        baseCurrencyCode: 'usd',
        baseCurrencyAmount: '500',
        externalTransactionId: '123123',
        externalCustomerId: 'braze+customer@example.com',
        redirectURL: 'bitpay://moonpay'
      }
    };

    const { urlWithSignature } = moonpay.moonpayGetSignedPaymentUrl(req);
    const queryStart = urlWithSignature.indexOf('?');
    const signatureStart = urlWithSignature.lastIndexOf('&signature=');
    const signedQuery = urlWithSignature.slice(queryStart, signatureStart);
    const actualSignature = decodeURIComponent(urlWithSignature.slice(signatureStart + '&signature='.length));
    const expectedSignature = crypto
      .createHmac('sha256', 'secretKey2')
      .update(signedQuery)
      .digest('base64');

    signedQuery.should.include('externalCustomerId=braze%2Bcustomer%40example.com');
    actualSignature.should.equal(expectedSignature);
  });

  describe('#moonpayHandleWebhook', () => {
    const timestamp = '1710000000';

    const makeBuyPayload = () => ({
      type: 'transaction_updated',
      data: {
        id: 'buy-transaction-1',
        status: 'completed',
        createdAt: '2026-08-10T10:00:00.000Z',
        updatedAt: '2026-08-10T10:05:00.000Z',
        externalCustomerId: 'braze-customer-1',
        externalTransactionId: 'wallet-1-1710000000',
        baseCurrencyAmount: 500,
        baseCurrency: { code: 'usd' },
        quoteCurrencyAmount: 0.0042,
        currency: { code: 'btc' },
        paymentMethod: 'credit_debit_card',
        walletAddress: 'bc1qexample'
      }
    });

    const makeRequest = (body: any, key: string, rawBody = JSON.stringify(body, null, 2)) => {
      const signature = crypto
        .createHmac('sha256', key)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

      return {
        headers: {
          'moonpay-signature-v2': `t=${timestamp},s=${signature}`
        },
        rawBody,
        body
      };
    };

    it('should verify Signature V2 against the exact raw body and map a production buy event', () => {
      const body = makeBuyPayload();
      const req = makeRequest(body, 'productionWebhookApiKey');

      const { event } = moonpay.moonpayHandleWebhook(req);

      event.partner.should.equal('moonpay');
      event.env.should.equal('production');
      event.externalId.should.equal('buy-transaction-1');
      event.eventName.should.equal('transaction_updated');
      event.status.should.equal('completed');
      event.createdAt.should.equal('2026-08-10T10:00:00.000Z');
      event.updatedAt.should.equal('2026-08-10T10:05:00.000Z');
      event.externalTransactionId.should.equal('wallet-1-1710000000');
      event.userId.should.equal('braze-customer-1');
      event.fiatAmount.should.equal(500);
      event.fiatCurrency.should.equal('USD');
      event.cryptoAmount.should.equal(0.0042);
      event.cryptoCurrency.should.equal('BTC');
      event.paymentMethod.should.equal('credit_debit_card');
      event.walletAddress.should.equal('bc1qexample');
    });

    it('should infer sandbox from the matching key and map sell currencies in their correct direction', () => {
      const body = {
        type: 'sell_transaction_updated',
        data: {
          id: 'sell-transaction-1',
          status: 'completed',
          createdAt: '2026-08-10T11:00:00.000Z',
          updatedAt: '2026-08-10T11:10:00.000Z',
          externalCustomerId: 'braze-customer-2',
          externalTransactionId: 'wallet-2-1710000000',
          baseCurrencyAmount: 0.25,
          baseCurrency: { code: 'eth' },
          quoteCurrencyAmount: 900,
          quoteCurrency: { code: 'eur' },
          payoutMethod: 'sepa_bank_transfer'
        }
      };
      const req = makeRequest(body, 'sandboxWebhookApiKey');

      const { event } = moonpay.moonpayHandleWebhook(req);

      event.env.should.equal('sandbox');
      event.externalId.should.equal('sell-transaction-1');
      event.eventName.should.equal('sell_transaction_updated');
      event.fiatAmount.should.equal(900);
      event.fiatCurrency.should.equal('EUR');
      event.cryptoAmount.should.equal(0.25);
      event.cryptoCurrency.should.equal('ETH');
      event.paymentMethod.should.equal('sepa_bank_transfer');
    });

    it('should reject a missing Signature V2 header', () => {
      const req = makeRequest(makeBuyPayload(), 'productionWebhookApiKey');
      delete req.headers['moonpay-signature-v2'];

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });

    it('should reject a malformed Signature V2 header', () => {
      const req = makeRequest(makeBuyPayload(), 'productionWebhookApiKey');
      req.headers['moonpay-signature-v2'] = `t=${timestamp},s=not-hex`;

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });

    it('should reject a raw body altered after it was signed', () => {
      const req = makeRequest(makeBuyPayload(), 'productionWebhookApiKey');
      req.rawBody += ' ';

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });

    it('should fail closed when no webhook API key is configured', () => {
      for (const moonpayEnv of ['sandbox', 'production']) {
        const envConfig = config.moonpay[moonpayEnv];
        delete envConfig.webhookApiKey;
        delete envConfig.webhookApiKeyEmbedded;
        delete envConfig.webhookSecretKey;
        delete envConfig.webhookSecretKeyEmbedded;
      }
      const req = makeRequest(makeBuyPayload(), 'productionWebhookApiKey');

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });

    for (const field of ['id', 'updatedAt']) {
      it(`should reject a MoonPay event without data.${field}`, () => {
        const body = makeBuyPayload();
        delete body.data[field];
        const req = makeRequest(body, 'productionWebhookApiKey');

        should.throw(() => moonpay.moonpayHandleWebhook(req));
      });
    }

    it('should reject a MoonPay event without a type', () => {
      const body: any = makeBuyPayload();
      delete body.type;
      const req = makeRequest(body, 'productionWebhookApiKey');

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });

    it('should reject a MoonPay event with an empty type', () => {
      const body = makeBuyPayload();
      body.type = '';
      const req = makeRequest(body, 'productionWebhookApiKey');

      should.throw(() => moonpay.moonpayHandleWebhook(req));
    });
  });
});

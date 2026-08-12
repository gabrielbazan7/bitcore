import * as crypto from 'crypto';
import { BitcoreLib as Bitcore } from '@bitpay-labs/crypto-wallet-core';
import * as request from 'request';
import config from '../config';
import { Utils } from '../lib/common/utils';
import { ClientError } from '../lib/errors/clienterror';
import { logger } from '../lib/logger';
import { OnrampWebhookEvent } from '../lib/model/onrampWebhookEvent';
import { checkRequired } from '../lib/server';

export class MoonpayService {
  request: any = request;

  private moonpayGetKeys(req) {
    if (!config.moonpay) throw new Error('Moonpay missing credentials');

    let env: 'sandbox' | 'production' | 'sandboxWeb' | 'productionWeb';
    env = req.body.env === 'production' ? 'production' : 'sandbox';
    if (req.body.context === 'web') {
      env += 'Web';
    }

    delete req.body.env;
    delete req.body.context;

    const keys: {
      API: string;
      WIDGET_API: string;
      SELL_WIDGET_API: string;
      API_KEY: string;
      SECRET_KEY: string;
      SECRET_KEY_EMBEDDED: string | undefined;
    } = {
      API: config.moonpay[env].api,
      WIDGET_API: config.moonpay[env].widgetApi,
      SELL_WIDGET_API: config.moonpay[env].sellWidgetApi,
      API_KEY: config.moonpay[env].apiKey,
      SECRET_KEY: config.moonpay[env].secretKey,
      SECRET_KEY_EMBEDDED: config.moonpay[env].secretKeyEmbedded
    };

    return keys;
  }

  moonpayGetCurrencies(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;

      const headers = {
        'Content-Type': 'application/json'
      };

      const URL = API + '/v3/currencies/';

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetQuote(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      if (!checkRequired(req.body, ['currencyAbbreviation', 'baseCurrencyAmount', 'baseCurrencyCode'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        'Content-Type': 'application/json'
      };

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);
      qs.push('baseCurrencyAmount=' + req.body.baseCurrencyAmount);
      qs.push('baseCurrencyCode=' + req.body.baseCurrencyCode);

      if (req.body.extraFeePercentage) qs.push('extraFeePercentage=' + req.body.extraFeePercentage);
      if (req.body.paymentMethod) qs.push('paymentMethod=' + req.body.paymentMethod);
      if (req.body.areFeesIncluded) qs.push('areFeesIncluded=' + req.body.areFeesIncluded);

      const URL: string = API + `/v3/currencies/${req.body.currencyAbbreviation}/buy_quote/?${qs.join('&')}`;

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetSellQuote(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      if (!checkRequired(req.body, ['currencyAbbreviation', 'quoteCurrencyCode', 'baseCurrencyAmount'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        'Content-Type': 'application/json'
      };

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);
      qs.push('quoteCurrencyCode=' + req.body.quoteCurrencyCode);
      qs.push('baseCurrencyAmount=' + req.body.baseCurrencyAmount);

      if (req.body.extraFeePercentage) qs.push('extraFeePercentage=' + req.body.extraFeePercentage);
      if (req.body.payoutMethod) qs.push('payoutMethod=' + req.body.payoutMethod);

      const URL: string = API + `/v3/currencies/${req.body.currencyAbbreviation}/sell_quote?${qs.join('&')}`;

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetCurrencyLimits(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      if (!checkRequired(req.body, ['currencyAbbreviation', 'baseCurrencyCode'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        'Content-Type': 'application/json'
      };

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);
      qs.push('baseCurrencyCode=' + encodeURIComponent(req.body.baseCurrencyCode));
      if (req.body.areFeesIncluded) qs.push('areFeesIncluded=' + encodeURIComponent(req.body.areFeesIncluded));
      if (req.body.paymentMethod) qs.push('paymentMethod=' + encodeURIComponent(req.body.paymentMethod));

      const URL = API + `/v3/currencies/${req.body.currencyAbbreviation}/limits/?${qs.join('&')}`;

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetSignedPaymentUrl(req): { urlWithSignature: string } {
    // moonpayGetKeys deletes env/context from the body, so read context first
    const isWebContext = req.body.context === 'web';
    const keys = this.moonpayGetKeys(req);
    const SECRET_KEY = keys.SECRET_KEY;
    const API_KEY = keys.API_KEY;
    const WIDGET_API = keys.WIDGET_API;

    if (
      !checkRequired(req.body, [
        'currencyCode',
        'walletAddress',
        'baseCurrencyCode',
        'baseCurrencyAmount',
        'externalTransactionId',
        'redirectURL'
      ])
    ) {
      throw new ClientError("Moonpay's request missing arguments");
    }

    const qs: string[] = [];
    qs.push('apiKey=' + API_KEY);
    qs.push('currencyCode=' + encodeURIComponent(req.body.currencyCode));
    qs.push('walletAddress=' + encodeURIComponent(req.body.walletAddress));
    qs.push('baseCurrencyCode=' + encodeURIComponent(req.body.baseCurrencyCode));
    qs.push('baseCurrencyAmount=' + encodeURIComponent(req.body.baseCurrencyAmount));
    qs.push('externalTransactionId=' + encodeURIComponent(req.body.externalTransactionId));
    qs.push('redirectURL=' + encodeURIComponent(req.body.redirectURL));
    if (req.body.externalCustomerId)
      qs.push('externalCustomerId=' + encodeURIComponent(req.body.externalCustomerId));
    if (req.body.lockAmount) qs.push('lockAmount=' + encodeURIComponent(req.body.lockAmount));
    if (req.body.colorCode) qs.push('colorCode=' + encodeURIComponent(req.body.colorCode));
    if (req.body.theme) qs.push('theme=' + encodeURIComponent(req.body.theme));
    if (req.body.language) qs.push('language=' + encodeURIComponent(req.body.language));
    if (req.body.showWalletAddressForm)
      qs.push('showWalletAddressForm=' + encodeURIComponent(req.body.showWalletAddressForm));
    if (req.body.paymentMethod) qs.push('paymentMethod=' + encodeURIComponent(req.body.paymentMethod));
    if (req.body.areFeesIncluded) qs.push('areFeesIncluded=' + encodeURIComponent(req.body.areFeesIncluded));

    // Web requests are proxied through the bitpay backend, so the IP on this
    // request belongs to that server, not the customer. The proxy captures the
    // customer's public IP and forwards it as deviceIp. Web credentials are only
    // held by the proxy, so the forwarded value is trusted for that context only.
    // If the proxy does not forward an IP, omit allowedIpAddress rather than
    // signing an IP the customer will never match.
    let deviceIp = isWebContext ? req.body.deviceIp : Utils.getIpFromReq(req);
    if (!deviceIp && !isWebContext) {
      throw new ClientError('Could not determine device IP address');
    }
    if (deviceIp) {
      // Canonicalize before hashing: HMAC is byte-exact and MoonPay hashes the
      // plain IPv4 it observes, while dual-stack sockets report IPv4 clients as
      // IPv4-mapped IPv6 (::ffff:1.2.3.4) - strip the prefix so both sides
      // hash the same string
      deviceIp = String(deviceIp).trim().replace(/^::ffff:/i, '');
      const allowedIpAddress: string = Bitcore.crypto.Hash.sha256hmac(
        Buffer.from(deviceIp),
        Buffer.from(SECRET_KEY)
      ).toString('base64');
      qs.push('allowedIpAddress=' + encodeURIComponent(allowedIpAddress));
    }

    const URL_SEARCH: string = `?${qs.join('&')}`;

    const URLSignatureHash: string = Bitcore.crypto.Hash.sha256hmac(
      Buffer.from(URL_SEARCH),
      Buffer.from(SECRET_KEY)
    ).toString('base64');

    const urlWithSignature = `${WIDGET_API}${URL_SEARCH}&signature=${encodeURIComponent(URLSignatureHash)}`;

    return { urlWithSignature };
  }

  moonpayGetSellSignedPaymentUrl(req): { urlWithSignature: string } {
    const keys = this.moonpayGetKeys(req);
    const SECRET_KEY = keys.SECRET_KEY;
    const API_KEY = keys.API_KEY;
    const SELL_WIDGET_API = keys.SELL_WIDGET_API;

    if (
      !checkRequired(req.body, [
        'baseCurrencyCode',
        'baseCurrencyAmount',
        'externalTransactionId',
        'redirectURL',
      ])
    ) {
      throw new ClientError("Moonpay's request missing arguments");
    }

    const qs: string[] = [];
    qs.push('apiKey=' + API_KEY);
    qs.push('baseCurrencyCode=' + encodeURIComponent(req.body.baseCurrencyCode));
    qs.push('baseCurrencyAmount=' + encodeURIComponent(req.body.baseCurrencyAmount));
    qs.push('externalTransactionId=' + encodeURIComponent(req.body.externalTransactionId));
    qs.push('redirectURL=' + encodeURIComponent(req.body.redirectURL));

    if (req.body.quoteCurrencyCode) qs.push('quoteCurrencyCode=' + encodeURIComponent(req.body.quoteCurrencyCode));
    if (req.body.paymentMethod) qs.push('paymentMethod=' + encodeURIComponent(req.body.paymentMethod));
    if (req.body.refundWalletAddress) qs.push('refundWalletAddress=' + encodeURIComponent(req.body.refundWalletAddress));
    if (req.body.lockAmount) qs.push('lockAmount=' + encodeURIComponent(req.body.lockAmount));
    if (req.body.colorCode) qs.push('colorCode=' + encodeURIComponent(req.body.colorCode));
    if (req.body.theme) qs.push('theme=' + encodeURIComponent(req.body.theme));
    if (req.body.language) qs.push('language=' + encodeURIComponent(req.body.language));
    if (req.body.email) qs.push('email=' + encodeURIComponent(req.body.email));
    if (req.body.externalCustomerId) qs.push('externalCustomerId=' + encodeURIComponent(req.body.externalCustomerId));
    if (req.body.showWalletAddressForm)
      qs.push('showWalletAddressForm=' + encodeURIComponent(req.body.showWalletAddressForm));
    if (req.body.unsupportedRegionRedirectUrl) qs.push('unsupportedRegionRedirectUrl=' + encodeURIComponent(req.body.unsupportedRegionRedirectUrl));
    if (req.body.skipUnsupportedRegionScreen) qs.push('skipUnsupportedRegionScreen=' + encodeURIComponent(req.body.skipUnsupportedRegionScreen));

    const URL_SEARCH: string = `?${qs.join('&')}`;

    const URLSignatureHash: string = Bitcore.crypto.Hash.sha256hmac(
      Buffer.from(URL_SEARCH),
      Buffer.from(SECRET_KEY)
    ).toString('base64');

    const urlWithSignature = `${SELL_WIDGET_API}${URL_SEARCH}&signature=${encodeURIComponent(URLSignatureHash)}`;

    return { urlWithSignature };
  }

  moonpayGetTransactionDetails(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      if (!checkRequired(req.body, ['transactionId']) && !checkRequired(req.body, ['externalId'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        'Content-Type': 'application/json'
      };
      let URL: string = '';

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);
      if (req.body.transactionId) {
        URL = API + `/v1/transactions/${req.body.transactionId}?${qs.join('&')}`;
      } else if (req.body.externalId) {
        URL = API + `/v1/transactions/ext/${req.body.externalId}?${qs.join('&')}`;
      }

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetSellTransactionDetails(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      if (!checkRequired(req.body, ['transactionId']) && !checkRequired(req.body, ['externalId'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        'Content-Type': 'application/json'
      };
      let URL: string = '';

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);
      if (req.body.transactionId) {
        URL = API + `/v3/sell_transactions/${req.body.transactionId}?${qs.join('&')}`;
      } else if (req.body.externalId) {
        URL = API + `/v3/sell_transactions/ext/${req.body.externalId}?${qs.join('&')}`;
      }

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayCancelSellTransaction(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const SECRET_KEY = keys.SECRET_KEY;

      if (!checkRequired(req.body, ['transactionId']) && !checkRequired(req.body, ['externalId'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        Authorization: 'Api-Key ' + SECRET_KEY,
        Accept: 'application/json'
      };
      let URL: string = '';

      if (req.body.transactionId) {
        URL = API + `/v3/sell_transactions/${req.body.transactionId}`;
      } else if (req.body.externalId) {
        URL = API + `/v3/sell_transactions/ext/${req.body.externalId}`;
      }

      this.request.delete(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayGetAccountDetails(req): Promise<any> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const API_KEY = keys.API_KEY;

      const headers = {
        'Content-Type': 'application/json'
      };

      const qs: string[] = [];
      qs.push('apiKey=' + API_KEY);

      const URL = API + `/v3/accounts/me?${qs.join('&')}`;

      this.request.get(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  moonpayCreateSession(req): Promise<{ sessionToken: string }> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const SECRET_KEY = keys.SECRET_KEY_EMBEDDED;

      if (!checkRequired(req.body, ['externalCustomerId'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const deviceIp = Utils.getIpFromReq(req);
      if (!deviceIp) {
        return reject(new ClientError('Could not determine device IP address'));
      }

      const headers = {
        'Content-Type': 'application/json',
        'X-Api-Key': SECRET_KEY,
      };

      const body: any = {
        externalCustomerId: req.body.externalCustomerId,
        deviceIp
      };
      if (req.body.email) body.email = req.body.email;
      if (req.body.phoneNumber) body.phoneNumber = req.body.phoneNumber;

      const URL = API + '/platform/v1/sessions';

      this.request.post(
        URL,
        {
          headers,
          body,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ?? err);
          } else {
            return resolve(data.body ?? data);
          }
        }
      );
    });
  }

  moonpayRevokeActiveSession(req): Promise<void> {
    return new Promise((resolve, reject) => {
      const keys = this.moonpayGetKeys(req);
      const API = keys.API;
      const SECRET_KEY = keys.SECRET_KEY_EMBEDDED;

      if (!checkRequired(req.body, ['externalCustomerId'])) {
        return reject(new ClientError("Moonpay's request missing arguments"));
      }

      const headers = {
        Accept: 'application/json',
        'X-Api-Key': SECRET_KEY
      };

      const URL = API + '/platform/v1/sessions?externalCustomerId=' + encodeURIComponent(req.body.externalCustomerId);

      this.request.delete(
        URL,
        {
          headers,
          json: true
        },
        (err, data) => {
          if (err) {
            return reject(err.body ? err.body : err);
          } else {
            return resolve(data.body ? data.body : data);
          }
        }
      );
    });
  }

  /**
   * Handles incoming MoonPay webhook events.
   * MoonPay signs requests with HMAC-SHA256. Header: Moonpay-Signature-V2
   * Format: t=<timestamp>,s=<signature>
   * Signed string: timestamp + '.' + rawBody
   * https://dev.moonpay.com/api-reference/widget/webhooks/signature
   */
  moonpayHandleWebhook(req): { event: OnrampWebhookEvent } {
    if (!config.moonpay) throw new Error('MoonPay missing credentials');

    const keyCandidates: {
      key: string;
      env: 'sandbox' | 'production';
      isEmbedded: boolean;
    }[] = [];
    const addKeyCandidates = (credentials, env: 'sandbox' | 'production') => {
      if (!credentials) return;
      const standardKey = credentials.webhookApiKey || credentials.webhookSecretKey;
      const embeddedKey = credentials.webhookApiKeyEmbedded || credentials.webhookSecretKeyEmbedded;
      if (standardKey) keyCandidates.push({ key: standardKey, env, isEmbedded: false });
      if (embeddedKey) keyCandidates.push({ key: embeddedKey, env, isEmbedded: true });
    };
    addKeyCandidates(config.moonpay.production, 'production');
    addKeyCandidates(config.moonpay.sandbox, 'sandbox');

    if (!keyCandidates.length) {
      const err: any = new Error('MoonPay webhook API key is not configured');
      err.retryable = true;
      throw err;
    }

    const signatureHeader = req.headers?.['moonpay-signature-v2'];
    if (typeof signatureHeader !== 'string' || !signatureHeader) {
      throw new Error('MoonPay webhook missing Moonpay-Signature-V2 header');
    }

    let matched: (typeof keyCandidates)[number];
    try {
      const parts: Record<string, string> = {};
      for (const segment of signatureHeader.split(',')) {
        const match = /^\s*([ts])=([^,]+)\s*$/.exec(segment);
        if (!match || parts[match[1]]) throw new Error('Invalid Moonpay-Signature-V2 header');
        parts[match[1]] = match[2].trim();
      }
      if (!/^\d+$/.test(parts.t || '') || !/^[a-fA-F0-9]{64}$/.test(parts.s || '')) {
        throw new Error('Invalid Moonpay-Signature-V2 header');
      }

      const rawBody = (req as any).rawBody;
      if (typeof rawBody !== 'string') {
        const err: any = new Error('MoonPay webhook raw body is unavailable');
        err.retryable = true;
        throw err;
      }

      const signedPayload = `${parts.t}.${rawBody}`;
      const given = Buffer.from(parts.s, 'hex');
      matched = keyCandidates.find(({ key }) => {
        const expected = crypto.createHmac('sha256', key).update(signedPayload).digest();
        return crypto.timingSafeEqual(expected, given);
      });
      if (!matched) throw new Error('MoonPay webhook signature mismatch');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
      logger.warn('MoonPay webhook signature error: %s', errMsg);
      if ((err as any)?.retryable) throw err;
      throw new Error('MoonPay webhook signature verification failed');
    }

    const body = req.body || {};
    const data = body.data || {};
    if (typeof body.type !== 'string' || !body.type) {
      throw new Error('MoonPay webhook missing event type');
    }
    if (typeof data.id !== 'string' || !data.id) {
      throw new Error('MoonPay webhook missing transaction id');
    }
    if (typeof data.updatedAt !== 'string' || Number.isNaN(Date.parse(data.updatedAt))) {
      throw new Error('MoonPay webhook missing valid updatedAt');
    }
    if (typeof data.status !== 'string' || !data.status) {
      throw new Error('MoonPay webhook missing transaction status');
    }

    const isSell = body.type.startsWith('sell_transaction_');
    const fiatAmount = isSell ? data.quoteCurrencyAmount : data.baseCurrencyAmount;
    const cryptoAmount = isSell ? data.baseCurrencyAmount : data.quoteCurrencyAmount;
    const asNumber = value => {
      if (value == null || value === '') return undefined;
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    };
    const normalizedFiatAmount = asNumber(fiatAmount);
    const normalizedCryptoAmount = asNumber(cryptoAmount);

    const event = OnrampWebhookEvent.create({
      partner: 'moonpay',
      externalId: data.id,
      externalTransactionId: data.externalTransactionId,
      status: data.status,
      eventName: body.type,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      fiatAmount: normalizedFiatAmount,
      fiatCurrency: (isSell ? data.quoteCurrency?.code : data.baseCurrency?.code)?.toUpperCase(),
      cryptoAmount: normalizedCryptoAmount,
      cryptoCurrency: (isSell ? data.baseCurrency?.code : data.currency?.code)?.toUpperCase(),
      feeAmount: asNumber(data.feeAmount),
      extraFeeAmount: asNumber(data.extraFeeAmount),
      networkFeeAmount: asNumber(data.networkFeeAmount),
      exchangeRate:
        normalizedFiatAmount != null && normalizedCryptoAmount
          ? normalizedFiatAmount / normalizedCryptoAmount
          : undefined,
      paymentMethod: isSell ? data.payoutMethod : data.paymentMethod,
      chain: (isSell ? data.baseCurrency : data.currency)?.metadata?.networkCode,
      walletAddress: data.walletAddress,
      walletAddressTag: data.walletAddressTag,
      userId: data.externalCustomerId || body.externalCustomerId,
      rawPayload: body,
      env: matched.env,
      isEmbedded: matched.isEmbedded
    });

    return { event };
  }
}

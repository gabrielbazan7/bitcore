import { BrazeCustomEvent, BrazeService } from '../externalservices/braze';
import { logger } from './logger';
import { OnrampWebhookEvent } from './model/onrampWebhookEvent';
import { Storage } from './storage';

const MOONPAY_PURCHASE_ACTION = 'braze-purchased-buy-crypto';
const DEFAULT_MOONPAY_PURCHASE_EVENT = 'BitPay App - Webhook - Purchased Buy Crypto';
const MOONPAY_BUY_EVENTS = new Set(['transaction_created', 'transaction_updated']);

export interface OnrampWebhookProcessorOptions {
  moonpayPurchaseEventName?: string;
}

export interface OnrampWebhookProcessResult {
  deliveryInserted: boolean;
  action?: 'sent' | 'duplicate' | 'skipped';
  reason?: string;
}

type BrazeClient = Pick<BrazeService, 'logCustomEvent'>;
type BrazeClientFactory = () => BrazeClient;

export class OnrampWebhookProcessor {
  constructor(
    private readonly storage: Storage,
    private readonly createBrazeClient: BrazeClientFactory,
    private readonly opts: OnrampWebhookProcessorOptions = {}
  ) {}

  async processMoonpay(event: OnrampWebhookEvent): Promise<OnrampWebhookProcessResult> {
    const delivery = await this.storage.storeOnrampWebhookEvent({ event });

    if (!event.eventName || !MOONPAY_BUY_EVENTS.has(event.eventName) || event.status.toLowerCase() !== 'completed') {
      return { deliveryInserted: delivery.inserted, action: 'skipped', reason: 'not-completed-buy' };
    }

    const userId = event.userId?.trim();
    if (!userId) {
      logger.warn(
        '[webhook:moonpay] Completed transaction %s has no externalCustomerId; Braze event skipped',
        event.externalId
      );
      return { deliveryInserted: delivery.inserted, action: 'skipped', reason: 'missing-user-id' };
    }

    const brazeEvent = this.createMoonpayPurchaseEvent(event, userId);
    const claim = await this.storage.claimOnrampWebhookAction({
      provider: event.partner,
      env: event.env,
      action: MOONPAY_PURCHASE_ACTION,
      transactionId: event.externalId,
      payload: brazeEvent
    });

    if (!claim.claimed) {
      if (claim.action?.status === 'processed') {
        return { deliveryInserted: delivery.inserted, action: 'duplicate' };
      }
      throw new Error(`MoonPay webhook action ${claim.action?._id || event.externalId} is already processing`);
    }

    const actionId = claim.action._id;
    const leaseId = claim.action.leaseId;
    if (!actionId || !leaseId) throw new Error('Claimed MoonPay webhook action has no lease');
    try {
      logger.info(
        '[webhook:moonpay] Sending Braze event "%s" externalId=%s transaction=%s attempt=%s',
        brazeEvent.name,
        brazeEvent.externalId,
        event.externalId,
        claim.action.attempts
      );
      const result = await this.createBrazeClient().logCustomEvent(brazeEvent);
      const processed = await this.storage.markOnrampWebhookActionProcessed({
        id: actionId,
        leaseId,
        result: {
          message: result?.message,
          eventsProcessed: result?.events_processed
        }
      });
      if (!processed) throw new Error('MoonPay webhook action lease was lost before completion');
      logger.info(
        '[webhook:moonpay] Braze accepted event for externalId=%s eventsProcessed=%s',
        brazeEvent.externalId,
        result?.events_processed
      );
      return { deliveryInserted: delivery.inserted, action: 'sent' };
    } catch (err) {
      try {
        await this.storage.markOnrampWebhookActionFailed({
          id: actionId,
          leaseId,
          error: err instanceof Error ? err.message : String(err)
        });
      } catch (markErr) {
        logger.error('[webhook:moonpay] Failed to persist Braze delivery error: %o', markErr);
      }
      throw err;
    }
  }

  private createMoonpayPurchaseEvent(event: OnrampWebhookEvent, userId: string): BrazeCustomEvent {
    // The app reports the total the customer paid and every fee rolled together
    // (fiat_total_amount / totalAmount - baseCurrencyAmount), while MoonPay sends
    // the base amount and each fee apart. Recombine them so both sources of this
    // event mean the same thing in Braze.
    const feeAmount = this.sumAmounts([event.feeAmount, event.extraFeeAmount, event.networkFeeAmount]);
    const fiatAmount = this.sumAmounts([event.fiatAmount, feeAmount]);

    const properties = this.withoutEmptyValues({
      exchange: 'moonpay',
      fiatAmount,
      feeAmount,
      fiatCurrency: event.fiatCurrency,
      coin: event.cryptoCurrency?.toLowerCase(),
      chain: event.chain?.toLowerCase(),
      cryptoAmount: event.cryptoAmount,
      paymentMethod: event.paymentMethod,
      exchangeRate: event.exchangeRate,
      isEmbedded: event.isEmbedded,
      // Not part of the app payload: lets Braze tell the two sources apart while
      // the client-side track is still live.
      source: 'moonpay_webhook'
    });

    return {
      externalId: userId,
      name: this.opts.moonpayPurchaseEventName || DEFAULT_MOONPAY_PURCHASE_EVENT,
      time: event.updatedAt,
      properties
    };
  }

  /** Rounds to cents so recombining fiat amounts cannot leak float artifacts into Braze. */
  private sumAmounts(amounts: Array<number | undefined>): number | undefined {
    const present = amounts.filter(amount => typeof amount === 'number' && Number.isFinite(amount));
    if (!present.length) return undefined;
    return Math.round(present.reduce((total, amount) => total + amount, 0) * 100) / 100;
  }

  private withoutEmptyValues(properties: Record<string, unknown>): Record<string, unknown> {
    return Object.keys(properties).reduce((result, key) => {
      if (properties[key] !== undefined && properties[key] !== null && properties[key] !== '') {
        result[key] = properties[key];
      }
      return result;
    }, {} as Record<string, unknown>);
  }
}

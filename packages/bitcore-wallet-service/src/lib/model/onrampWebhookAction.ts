import { IOnrampWebhookEvent } from './onrampWebhookEvent';

export type OnrampWebhookActionStatus = 'processing' | 'processed' | 'failed';

export interface IStoredOnrampWebhookEvent extends Omit<
  IOnrampWebhookEvent,
  'eventName' | 'rawPayload' | 'updatedAt' | 'walletAddress' | 'walletAddressTag'
> {
  _id: string;
  eventName: string;
  updatedAt: string;
  expiresAt: Date;      // TTL index anchor; the delivery log is not kept forever
}

export interface IOnrampWebhookAction {
  _id: string;
  provider: string;
  env: string;
  action: string;
  transactionId: string;
  status: OnrampWebhookActionStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  payload?: object;
  leaseId?: string;
  processingStartedAt?: number;
  leaseExpiresAt?: number;
  processedAt?: number;
  failedAt?: number;
  lastError?: string;
  result?: object;
}

export interface IStoreOnrampWebhookEventResult {
  inserted: boolean;
  id: string;
  event: IStoredOnrampWebhookEvent;
}

export interface IClaimOnrampWebhookActionResult {
  claimed: boolean;
  action: IOnrampWebhookAction;
}

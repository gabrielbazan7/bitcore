import express from 'express';
import { logger } from '../logger';
import { OnrampWebhookEvent } from '../model/onrampWebhookEvent';
import type * as Types from '../../types/expressapp';

interface RouteContext {
  getServer: Types.GetServerFn;
  returnError: Types.ReturnErrorFn;
}

/**
 * Shared handler: parse and verify an event, optionally process it, then acknowledge it.
 * Invalid payloads/signatures get a 400; retryable configuration or delivery failures get a 503.
 */
async function handleWebhook(
  req: express.Request,
  res: express.Response,
  partner: string,
  parseEvent: () => { event: OnrampWebhookEvent },
  processEvent?: (event: OnrampWebhookEvent) => Promise<unknown>
): Promise<express.Response> {
  let event: OnrampWebhookEvent;
  try {
    ({ event } = parseEvent());
  } catch (err) {
    logger.error(`[webhook:${partner}] Failed to process payload: %o`, err);
    const status = (err as any)?.retryable ? 503 : 400;
    return res.status(status).json({ error: (err as Error).message });
  }

  logger.info(`[webhook:${partner}] Received event externalId=%s status=%s`, event?.externalId, event?.status);

  if (processEvent) {
    try {
      await processEvent(event);
    } catch (err) {
      logger.error(`[webhook:${partner}] Failed to persist or deliver event: %o`, err);
      return res.status(503).json({ error: 'Webhook processing temporarily unavailable' });
    }
  }
  return res.status(200).json({ ok: true });
}

export function registerWebhookRoutes(router: express.Router, context: RouteContext) {
  const { getServer } = context;

  /**
   * POST /v1/service/simplex/webhook
   * Simplex payment event webhook. Secured with RS256 JWT in X-Signature-SHA256.
   */
  router.post('/v1/service/simplex/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'simplex',
      () => server.externalServices.simplex.simplexHandleWebhook(req)
    );
  });

  /**
   * POST /v1/service/moonpay/webhook
   * MoonPay buy/sell transaction event. Secured with HMAC-SHA256 in moonpay-signature-v2.
   */
  router.post('/v1/service/moonpay/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    return handleWebhook(
      req, res, 'moonpay',
      () => server.externalServices.moonpay.moonpayHandleWebhook(req),
      event => server.onrampWebhookProcessor.processMoonpay(event)
    );
  });

  /**
   * POST /v1/service/ramp/webhook
   * Ramp buy (purchase) event. Configured via webhookStatusUrl in the Ramp widget.
   */
  router.post('/v1/service/ramp/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'ramp',
      () => server.externalServices.ramp.rampHandleWebhook(req)
    );
  });

  /**
   * POST /v1/service/ramp/offramp-webhook
   * Ramp sell (offramp) event. Configured via offrampWebhookV3Url in the Ramp widget.
   */
  router.post('/v1/service/ramp/offramp-webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'ramp',
      () => server.externalServices.ramp.rampHandleWebhook(req)
    );
  });

  /**
   * POST /v1/service/transak/webhook
   * Transak order event. Payload data field is a HS256 JWT signed with SECRET_KEY.
   */
  router.post('/v1/service/transak/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'transak',
      () => server.externalServices.transak.transakHandleWebhook(req)
    );
  });

  /**
   * POST /v1/service/banxa/webhook
   * Banxa order status event. Secured with HMAC-SHA256 in Authorization header.
   */
  router.post('/v1/service/banxa/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'banxa',
      () => server.externalServices.banxa.banxaHandleWebhook(req)
    );
  });

  /**
   * POST /v1/service/sardine/webhook
   * Sardine order event. Optionally secured with HMAC-SHA256 in X-Sardine-Signature.
   */
  router.post('/v1/service/sardine/webhook', (req, res) => {
    const server = getServer(req, res);
    if (!server) return;
    handleWebhook(
      req, res, 'sardine',
      () => server.externalServices.sardine.sardineHandleWebhook(req)
    );
  });
}

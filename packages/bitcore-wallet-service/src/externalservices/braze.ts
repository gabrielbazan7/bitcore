import * as request from 'request';

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 5000;

export interface BrazeServiceOptions {
  apiUrl: string;
  apiKey: string;
  appId?: string;
  timeout?: number;
}

export interface BrazeCustomEvent {
  externalId: string;
  name: string;
  time?: string | Date;
  properties?: Record<string, unknown>;
}

export interface BrazeTrackResponse {
  message: string;
  events_processed: number;
  errors?: unknown[];
  [key: string]: unknown;
}

export class BrazeServiceError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'BrazeServiceError';
    this.statusCode = statusCode;
  }
}

export class BrazeService {
  request: any = request;

  private readonly opts?: BrazeServiceOptions;

  constructor(opts?: BrazeServiceOptions) {
    this.opts = opts;
  }

  async logCustomEvent(event: BrazeCustomEvent): Promise<BrazeTrackResponse> {
    const { trackUrl, apiKey, appId, timeout } = this.getConfig();
    const externalId = event?.externalId?.trim();
    const name = event?.name?.trim();

    if (!externalId || !name) {
      throw new Error('Braze custom event requires externalId and name');
    }

    const brazeEvent: Record<string, unknown> = {
      external_id: externalId,
      name,
      time: this.normalizeTime(event.time),
      _update_existing_only: true
    };

    if (appId) brazeEvent.app_id = appId;
    if (event.properties !== undefined) brazeEvent.properties = event.properties;

    return new Promise((resolve, reject) => {
      this.request.post(
        trackUrl,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: { events: [brazeEvent] },
          json: true,
          timeout
        },
        (err, response, callbackBody) => {
          if (err) {
            return reject(new BrazeServiceError('Braze request failed'));
          }

          const statusCode = response?.statusCode;
          const body = callbackBody ?? response?.body;
          const fail = (message: string) => {
            const detail = this.describeFailure(body, apiKey);
            return reject(new BrazeServiceError(detail ? `${message}: ${detail}` : message, statusCode));
          };

          if (!statusCode || statusCode < 200 || statusCode >= 300) {
            return fail('Braze request failed');
          }

          if (!body || typeof body !== 'object' || body.message !== 'success') {
            return fail('Braze returned an unsuccessful response');
          }

          if (body.errors && (!Array.isArray(body.errors) || body.errors.length > 0)) {
            return fail('Braze returned event errors');
          }

          if (body.events_processed !== 1) {
            return fail('Braze did not process the event');
          }

          resolve(body as BrazeTrackResponse);
        }
      );
    });
  }

  /**
   * Summarizes why Braze rejected a request so the failure is actionable in the
   * logs. Braze echoes the rejected API key back in some error bodies, so the
   * key is redacted before the text can reach a log line.
   */
  private describeFailure(body: any, apiKey: string): string {
    let text: string;
    if (!body) return '';
    if (typeof body === 'string') {
      text = body;
    } else if (typeof body === 'object') {
      const parts: string[] = [];
      if (body.message !== undefined && body.message !== 'success') parts.push(String(body.message));
      if (body.errors !== undefined) {
        try {
          parts.push(JSON.stringify(body.errors));
        } catch {
          // Ignore bodies that cannot be serialized; the status code still tells the story.
        }
      }
      text = parts.join(' | ');
    } else {
      text = String(body);
    }

    if (!text) return '';
    return text.split(apiKey).join('[redacted]').slice(0, 300);
  }

  private getConfig(): { trackUrl: string; apiKey: string; appId?: string; timeout: number } {
    if (!this.opts?.apiUrl?.trim() || !this.opts?.apiKey?.trim()) {
      throw new BrazeServiceError('Braze missing credentials');
    }

    const timeout = this.opts.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout >= MAX_TIMEOUT_MS) {
      throw new BrazeServiceError('Braze timeout must be an integer below 5000ms');
    }

    return {
      trackUrl: `${this.opts.apiUrl.trim().replace(/\/+$/, '')}/users/track`,
      apiKey: this.opts.apiKey.trim(),
      appId: this.opts.appId?.trim() || undefined,
      timeout
    };
  }

  private normalizeTime(time?: string | Date): string {
    const date = time === undefined ? new Date() : time instanceof Date ? time : new Date(time);
    if (Number.isNaN(date.getTime())) throw new Error('Braze custom event has an invalid time');
    return date.toISOString();
  }
}

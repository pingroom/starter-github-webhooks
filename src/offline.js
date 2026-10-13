import { createHmac, randomUUID } from 'node:crypto';
import { PingRoom } from '@pingroom/sdk';

export const demoSecret = 'offline-example-secret-not-for-production';
export const issuePayload = {
  action: 'opened', repository: { full_name: 'example/project' },
  issue: { number: 42, title: 'Add a keyboard shortcut' },
};

/** Real SDK with injected transport. It never contacts PingRoom. */
export function createOfflineClient({ beforeSend } = {}) {
  const pings = [];
  const client = new PingRoom({
    token: 'offline-placeholder', baseUrl: 'https://github-demo.invalid', timeoutMs: 5000,
    fetch: async (url, init) => {
      if (new URL(url).origin !== 'https://github-demo.invalid' || init.method !== 'POST'
        || new URL(url).pathname !== '/api/agent/rooms/DEMO/notifications') throw new Error('Unexpected offline request.');
      if (beforeSend) await beforeSend();
      pings.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, id: `offline-${pings.length}` }), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, pings };
}

export async function postExample(url, { payload = issuePayload, event = 'issues', delivery = randomUUID(), secret = demoSecret, rawBody, headers } = {}) {
  const body = rawBody ?? JSON.stringify(payload);
  return fetch(`${url}/webhooks/github`, {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      ...headers,
    },
  });
}

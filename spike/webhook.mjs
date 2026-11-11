// Step 4: receive PayPal webhooks on :8787, verify signature with PayPal, append to webhook-log.jsonl.
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { api } from './paypal.mjs';

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', async () => {
    res.end('ok');
    if (req.method !== 'POST') return;
    const { webhookId } = JSON.parse(readFileSync('state.json'));
    const h = req.headers, event = JSON.parse(raw);
    const v = await api('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
      transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'],
      webhook_id: webhookId, webhook_event: event,
    });
    const line = { at: new Date().toISOString(), id: event.id, type: event.event_type, resource: event.resource?.id, verified: v.json.verification_status, verifyHttp: v.status, verifyErr: v.ok ? undefined : JSON.stringify(v.json).slice(0, 300) };
    appendFileSync('webhook-log.jsonl', JSON.stringify(line) + '\n');
    console.log(line);
  });
}).listen(+(process.env.PORT ?? 8788), () => console.log("receiver on", process.env.PORT ?? 8788));

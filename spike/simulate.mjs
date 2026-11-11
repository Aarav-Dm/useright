import { api } from './paypal.mjs';
const r = await api('POST', '/v1/notifications/simulate-event', { url: process.argv[2], event_type: 'PAYMENT.CAPTURE.COMPLETED', resource_version: '2.0' });
console.log('simulate', r.status, r.json.id ?? r.json.name);

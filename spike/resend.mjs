// Ask PayPal to resend a real event (resent events carry real signatures, unlike simulator events).
import { api } from './paypal.mjs';
const r = await api('POST', `/v1/notifications/webhooks-events/${process.argv[2]}/resend`, { webhook_ids: [process.argv[3]] });
console.log('resend', r.status, JSON.stringify(r.json).slice(0, 200));

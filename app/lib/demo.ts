// Batch 7: markers of the seeded demo data (db/seed-demo.ts). Read-only display flags: nothing in grant, send or
// pay logic reads them. A demo row must never look like live PayPal evidence on any screen.
export const DEMO_INVOICE_PREFIX = 'INV2-DEMO-';
export const DEMO_TXN_PREFIX = 'SEED-DEMO-';
/**
 * B8 review fix 8: the one seeded licence the tick may renew (its client asked for a renewal invoice), so the demo can
 * film a real renewal invoice going out. Still a demo payment everywhere it is shown (it starts with DEMO_TXN_PREFIX).
 */
export const DEMO_RENEWABLE_TXN_PREFIX = 'SEED-DEMO-RENEW-';
/** SQL: version `v` was not bought by a seeded payment the tick must leave alone (B8: seeded licences never renew). */
export const NOT_SEEDED_DEMO_SQL = `not exists (select 1 from payments p where p.version_id = v.id
  and p.paypal_txn_id like '${DEMO_TXN_PREFIX}%' and p.paypal_txn_id not like '${DEMO_RENEWABLE_TXN_PREFIX}%')`;

export const isDemoInvoiceId = (id: string | null | undefined): boolean => !!id && id.startsWith(DEMO_INVOICE_PREFIX);
export const isDemoTxnId = (id: string | null | undefined): boolean => !!id && id.startsWith(DEMO_TXN_PREFIX);

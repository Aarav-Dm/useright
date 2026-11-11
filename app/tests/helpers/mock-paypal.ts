// In-memory PayPal stand-in for tests: Invoicing (InvoiceApi) and payment reads (PaymentsApi) over one store.
// Records every call; failures are injected per operation.
import { PayPalError, PayPalTimeout } from '../../lib/paypal/client';
import type { InvoiceApi, InvoiceDraft, PayPalInvoice } from '../../lib/paypal/invoices';
import type { Capture, InvoiceJson, PaymentsApi } from '../../lib/paypal/payments';

type Op = 'create' | 'send' | 'get' | 'findByNumber' | 'cancel' | 'remove' | 'getInvoice' | 'getCapture' | 'verifyWebhook';
type Txn = { payment_id: string; method: string; type: string; payment_date?: string; amount: { currency_code: string; value: string }; payer?: { email_address: string } };
type Stored = PayPalInvoice & { draft: InvoiceDraft; transactions: Txn[]; paidValue: string | null; paidCurrency: string; dueValue: string | null };

let seq = 0; // shared across mocks: invoices.paypal_invoice_id and payments.paypal_txn_id are unique in the database

export function mockInvoiceApi() {
  const invoices = new Map<string, Stored>();
  const captures = new Map<string, Capture>();
  const calls: { op: Op; arg: string }[] = [];
  const failures: Partial<Record<Op, (() => unknown)[]>> = {};
  let afterCreate: ((inv: Stored) => void) | null = null;
  let verdict = 'SUCCESS';
  /**
   * Queue an outcome for the next call of `op`. `kind`: 'timeout', an HTTP status, 'created-then-timeout'
   * (create stores it, then times out), 'applied-then-500' (send goes out, then PayPal answers 500), or 'pass'.
   */
  const failNext = (op: Op, kind: 'timeout' | 'network' | number | 'created-then-timeout' | 'applied-then-500' | 'pass', issue: string | null = 'INTERNAL_SERVER_ERROR') => {
    (failures[op] ??= []).push(() => {
      if (kind === 'pass') return undefined;
      if (kind === 'timeout') throw new PayPalTimeout(op);
      if (kind === 'network') throw new TypeError('fetch failed'); // ordinary network rejection (B6 review F2)
      if (kind === 'created-then-timeout' || kind === 'applied-then-500') return kind;
      throw new PayPalError(kind, issue, 'debug-123');
    });
  };
  const pop = (op: Op) => failures[op]?.shift()?.();

  const api: InvoiceApi = {
    async create(d) {
      calls.push({ op: 'create', arg: d.invoiceNumber });
      const injected = pop('create');
      if ([...invoices.values()].some((i) => i.invoiceNumber === d.invoiceNumber)) throw new PayPalError(422, 'DUPLICATE_INVOICE_NUMBER', 'debug-dup');
      const id = `INV2-TEST-${String(++seq).padStart(4, '0')}`;
      const inv: Stored = {
        id, status: 'DRAFT', invoiceNumber: d.invoiceNumber, amountValue: (d.amountCents / 100).toFixed(2), currency: 'USD', payerUrl: null,
        allowTip: false, allowPartial: false, draft: d, transactions: [], paidValue: null, paidCurrency: 'USD', dueValue: (d.amountCents / 100).toFixed(2),
      };
      invoices.set(id, inv);
      afterCreate?.(inv);
      if (injected === 'created-then-timeout') throw new PayPalTimeout('create');
      return id;
    },
    async send(id) {
      calls.push({ op: 'send', arg: id });
      const injected = pop('send');
      const inv = invoices.get(id)!;
      inv.status = 'SENT';
      inv.payerUrl = `https://www.sandbox.paypal.com/invoice/p/#${id}`;
      if (injected === 'applied-then-500') throw new PayPalError(500, 'INTERNAL_SERVER_ERROR', 'debug-500');
    },
    async get(id) {
      calls.push({ op: 'get', arg: id });
      pop('get');
      const inv = invoices.get(id);
      if (!inv) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', null);
      return { ...inv };
    },
    async findByNumber(n) {
      calls.push({ op: 'findByNumber', arg: n });
      pop('findByNumber');
      const inv = [...invoices.values()].find((i) => i.invoiceNumber === n);
      return inv ? { ...inv } : null;
    },
    async cancel(id) {
      calls.push({ op: 'cancel', arg: id });
      pop('cancel');
      invoices.get(id)!.status = 'CANCELLED';
    },
    async remove(id) {
      calls.push({ op: 'remove', arg: id });
      pop('remove');
      invoices.delete(id);
    },
  };

  /** Invoice JSON in PayPal's v2 shape (the fields grantIfPaid reads). */
  const toJson = (i: Stored): InvoiceJson => ({
    id: i.id, status: i.status,
    detail: { invoice_number: i.invoiceNumber, currency_code: i.currency, note: i.draft.note, metadata: { recipient_view_url: i.payerUrl } },
    primary_recipients: [{ billing_info: { email_address: i.draft.recipientEmail } }],
    amount: { currency_code: i.currency, value: i.amountValue },
    due_amount: i.dueValue === null ? undefined : { currency_code: i.currency, value: i.dueValue },
    payments: i.paidValue === null ? undefined : { paid_amount: { currency_code: i.paidCurrency, value: i.paidValue }, transactions: i.transactions },
  });

  const payments: PaymentsApi = {
    async getInvoice(id) {
      calls.push({ op: 'getInvoice', arg: id });
      pop('getInvoice');
      const inv = invoices.get(id);
      if (!inv) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', null);
      return toJson(inv);
    },
    async getCapture(id) {
      calls.push({ op: 'getCapture', arg: id });
      pop('getCapture');
      const c = captures.get(id);
      if (!c) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', null);
      return { ...c };
    },
    async verifyWebhook(h) {
      calls.push({ op: 'verifyWebhook', arg: h.transmissionId });
      pop('verifyWebhook');
      return h.transmissionSig === 'bad' ? 'FAILURE' : verdict;
    },
  };

  const byNumber = (n: string) => [...invoices.values()].find((i) => i.invoiceNumber === n)!;

  /** The buyer pays in PayPal. Options bend the record to test each refusal. */
  function pay(id: string, o: { method?: string; value?: string; currency?: string; status?: string; date?: string | null; due?: string | null; payer?: string } = {}) {
    const inv = invoices.get(id)!;
    const txnId = `CAP${String(++seq).padStart(14, '0')}`;
    const value = o.value ?? inv.amountValue!;
    inv.status = o.status ?? 'PAID';
    inv.paidValue = value;
    inv.paidCurrency = o.currency ?? 'USD';
    inv.dueValue = o.due === undefined ? '0.00' : o.due;
    inv.transactions.push({ payment_id: txnId, method: o.method ?? 'PAYPAL', type: 'PAYMENT', ...(o.date === null ? {} : { payment_date: o.date ?? '2026-10-29' }), amount: { currency_code: inv.paidCurrency, value },
      ...(o.payer ? { payer: { email_address: o.payer } } : {}) });
    captures.set(txnId, { id: txnId, status: 'COMPLETED' });
    return txnId;
  }
  /** "Mark as paid" in the PayPal dashboard: no PayPal payment. */
  function markPaidManually(id: string) {
    const inv = invoices.get(id)!;
    inv.status = 'MARKED_AS_PAID';
    inv.paidValue = inv.amountValue;
    inv.dueValue = '0.00';
    inv.transactions.push({ payment_id: `EXT${String(++seq).padStart(14, '0')}`, method: 'BANK_TRANSFER', type: 'EXTERNAL', payment_date: '2026-10-29', amount: { currency_code: 'USD', value: inv.amountValue! } });
  }
  function refund(captureId: string, full = true) {
    captures.set(captureId, { id: captureId, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });
    const inv = [...invoices.values()].find((i) => i.transactions.some((t) => t.payment_id === captureId));
    if (inv) inv.status = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }
  function reverse(captureId: string) {
    captures.set(captureId, { id: captureId, status: 'REVERSED' });
  }

  const count = (op: Op) => calls.filter((c) => c.op === op).length;
  return {
    api, payments, pp: { invoices: api, payments }, invoices, captures, calls, count, failNext,
    pay, markPaidManually, refund, reverse, byNumber, toJson,
    setVerdict: (v: string) => { verdict = v; },
    onCreate: (fn: ((inv: Stored) => void) | null) => { afterCreate = fn; },
    reset: () => { calls.length = 0; },
  };
}

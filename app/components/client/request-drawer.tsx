'use client';
// Licence request drawer: a glass sheet from the right (full width on phones) that drags right to dismiss with
// velocity. Posts to the existing POST /api/intake: source 'portfolio' with a real asset id, or 'form' with the
// creator slug when the photo has no asset (never a made-up id). Spec §4 "Request drawer".
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MagneticButton } from './magnetic';
import type { PortfolioPhoto } from './types';
import { useReduce } from './motion-pref';

const USES = ['Social', 'Website', 'Print', 'Billboard', 'Out-of-home', 'TV', 'Ad campaign'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type State = 'idle' | 'sending' | 'confirm' | 'confirming' | 'sent';

export function RequestDrawer({ open, photo, photos, creatorSlug, creatorName, draft, onClose }: {
  open: boolean;
  draft?: string; // prefilled use text, e.g. from the estimator
  photo: PortfolioPhoto | null;
  photos: PortfolioPhoto[];
  creatorSlug: string;
  creatorName: string;
  onClose: () => void;
}) {
  const reduce = useReduce();
  const id = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const [num, setNum] = useState<string>('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [uses, setUses] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<{ email?: string; use?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<State>('idle');
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null);
  const session = useRef(0); // bumps on every open; a reply from an older session is ignored

  useEffect(() => {
    if (!open) return;
    session.current += 1;
    setNum(photo?.num ?? '');
    if (draft) setText(draft);
    setState('idle');
    setConfirmationToken(null);
    setNotice(null);
    const t = setTimeout(() => firstRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open, photo, draft, onClose]);

  const chosen = photos.find((p) => p.num === num) ?? null;
  const description = [uses.length ? `Use: ${uses.join(', ')}.` : '', text.trim()].filter(Boolean).join(' ');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid contact email.';
    if (!description) next.use = 'Tell us how you plan to use the photo.';
    setErrors(next);
    if (next.email || next.use) return;
    const words = chosen ? `Photo: ${chosen.title} (No. ${chosen.num}). ${description}` : description;
    const body = chosen?.assetId
      ? { source: 'portfolio', assetId: chosen.assetId, email: email.trim(), name: name.trim() || undefined, text: words, confirmOnPage: true }
      : { source: 'form', creatorSlug, email: email.trim(), name: name.trim() || undefined, text: words };
    setState('sending');
    setNotice(null);
    const mine = session.current;
    try {
      const res = await fetch('/api/intake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (mine !== session.current) return;
      if (res.ok) {
        if (body.source === 'form') { setState('sent'); return; }
        const saved = await res.json();
        if (mine !== session.current) return;
        if (!saved.confirmation?.token) throw new Error('confirmation unavailable');
        setConfirmationToken(saved.confirmation.token);
        setState('confirm');
        return;
      }
      setState('idle');
      setNotice(res.status === 429 ? 'Lots of requests from your network just now. Wait a few minutes, then send again.'
        : res.status === 400 ? 'Check your email and how you plan to use the photo, then send again.'
        : 'We could not send that. Try again in a moment.');
    } catch {
      if (mine !== session.current) return;
      setState('idle');
      setNotice('Could not reach the server. Check your connection, then try again.');
    }
  }

  async function confirm() {
    if (!confirmationToken || state === 'confirming') return;
    const mine = session.current;
    setState('confirming');
    setNotice(null);
    try {
      const res = await fetch(`/api/verify/${confirmationToken}/page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (mine !== session.current) return;
      if (res.ok) { setState('sent'); return; }
      setState('confirm');
      setNotice(res.status === 410 ? `This confirmation expired or was already used. We could not confirm your request in this attempt. Contact ${creatorName} before sending another request.`
        : res.status === 429 ? 'Too many confirmation attempts. Wait a while, then try again.'
        : 'We could not confirm that. Try again.');
    } catch {
      if (mine !== session.current) return;
      setState('confirm');
      setNotice('Could not reach the server. Check your connection, then confirm again.');
    }
  }

  const toggleUse = (u: string) => setUses((us) => (us.includes(u) ? us.filter((x) => x !== u) : [...us, u]));

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[400]" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
          <motion.div className="absolute inset-0 bg-[#060607]/60 backdrop-blur-sm" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }} />
          <motion.aside className="g-card absolute bottom-0 right-0 top-0 flex w-full max-w-[480px] flex-col !rounded-none sm:!rounded-l-[28px]"
            initial={reduce ? { opacity: 0 } : { transform: 'translateX(100%)' }}
            animate={reduce ? { opacity: 1 } : { transform: 'translateX(0%)' }}
            exit={reduce ? { opacity: 0 } : { transform: 'translateX(100%)', transition: { duration: 0.22, ease: [0.32, 0.72, 0, 1] } }}
            transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
            drag={reduce ? false : 'x'} dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0.02, right: 0.7 }}
            onDragEnd={(_, info) => { if (info.offset.x > 120 || info.velocity.x > 500) onClose(); }}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
              <h2 id={`${id}-title`} className="g-display text-3xl">Request a licence</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="g-btn g-btn-ghost g-btn-sm !h-10 !w-10 !p-0">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {state === 'confirm' || state === 'confirming' ? (
                <motion.div key="confirm" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <h3 ref={(el) => el?.focus()} tabIndex={-1} className="g-display text-3xl outline-none">Confirm your request</h3>
                  <p className="text-sm g-muted">Send this request to {creatorName} for review. This confirms the request on this page; it does not verify your email. No invoice is sent until {creatorName} approves.</p>
                  <p role="region" aria-label="Request summary" tabIndex={0} className="max-h-40 shrink-0 overflow-y-auto whitespace-pre-wrap break-words text-sm g-muted">Sending {chosen ? `No. ${chosen.num} ${chosen.title}` : 'no specific photo'}, {email.trim()}, and: {description}</p>
                  {notice && <p role="alert" className="text-sm text-[var(--g-danger)]">{notice}</p>}
                  <MagneticButton onClick={() => void confirm()} disabled={state === 'confirming'}>{state === 'confirming' ? 'Confirming…' : 'Confirm request'}</MagneticButton>
                </motion.div>
              ) : state === 'sent' ? (
                <motion.div key="sent" className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.96)', filter: 'blur(4px)' }} animate={reduce ? { opacity: 1 } : { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
                  transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }} role="status">
                  <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
                    <motion.circle cx="36" cy="36" r="33" stroke="url(#ok-g)" strokeWidth="2.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : 0.5 }} />
                    <motion.path d="M23 37l9 9 17-19" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                      initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : 0.35, delay: reduce ? 0 : 0.35 }} />
                    <defs><linearGradient id="ok-g"><stop stopColor="#F3F0EA" /><stop offset="1" stopColor="#E6B873" /></linearGradient></defs>
                  </svg>
                  <div>
                    <p ref={(el) => el?.focus()} tabIndex={-1} className="text-xl font-medium outline-none">Request sent</p>
                    <p className="mt-2 text-sm g-muted">{confirmationToken
                      ? `${creatorName} has your request. They will review it before sending any invoice; nothing else is needed from you. Your email has not been verified.`
                      : `${creatorName} has your request. When they reply, they will send a one-time link to confirm your email, then a quote.`}</p>
                  </div>
                  <MagneticButton variant="ghost" onClick={onClose}>Back to the work</MagneticButton>
                </motion.div>
              ) : (
                <motion.form key="form" onSubmit={submit} noValidate className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-6"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
                  <label className="grid gap-2 text-sm">
                    <span>Photo</span>
                    <select className="g-input" value={num} onChange={(e) => setNum(e.target.value)}>
                      <option value="" className="bg-[#0d0d10]">Not sure yet — confirm by email link</option>
                      {photos.map((p) => <option key={p.num} value={p.num} className="bg-[#0d0d10]">No. {p.num} · {p.title}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-2 text-sm">
                    <span>Email</span>
                    <input ref={firstRef} className="g-input" type="email" autoComplete="email" value={email} placeholder="you@studio.example"
                      onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? `${id}-email` : undefined} />
                    {errors.email && <span id={`${id}-email`} className="text-xs text-[var(--g-danger)]">{errors.email}</span>}
                  </label>
                  <label className="grid gap-2 text-sm">
                    <span>Name <span className="g-muted">(optional)</span></span>
                    <input className="g-input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan at Northwind" />
                  </label>
                  <fieldset className="grid gap-2 text-sm">
                    <legend className="mb-2">How you&apos;ll use it</legend>
                    <div className="flex flex-wrap gap-2">
                      {USES.map((u) => {
                        const on = uses.includes(u);
                        return (
                          <button key={u} type="button" aria-pressed={on} onClick={() => toggleUse(u)}
                            className={`h-9 rounded-full border px-4 transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] ${on ? 'border-transparent bg-[#f3f0ea] text-[#060607]' : 'border-white/10 g-muted hover:border-white/25 hover:text-white'}`}>
                            {u}
                          </button>
                        );
                      })}
                    </div>
                    <textarea className="g-input mt-2" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000}
                      placeholder="Where it runs, for how long, and anything else we should know."
                      aria-invalid={Boolean(errors.use)} aria-describedby={errors.use ? `${id}-use` : undefined} />
                    {errors.use && <span id={`${id}-use`} className="text-xs text-[var(--g-danger)]">{errors.use}</span>}
                  </fieldset>
                  {notice && <p role="alert" className="rounded-xl border border-[var(--g-danger)]/30 bg-[var(--g-danger)]/10 p-3 text-sm text-[var(--g-danger)]">{notice}</p>}
                  <div className="mt-auto pt-2">
                    <MagneticButton type="submit" className="w-full" disabled={state === 'sending'} arrow={state !== 'sending'}>
                      {state === 'sending' ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" /> Sending</> : 'Send request'}
                    </MagneticButton>
                    <p className="mt-3 text-center text-xs g-muted">Payments by PayPal. Files unlock only after PayPal confirms.</p>
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

// Email-confirm pages (code-review fix 4). GET only renders a button; the POST it submits uses the token,
// so mail link scanners that follow GET cannot burn it. Plain HTML: no React, no data from the database.

export const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${title}</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#111}` +
  `button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#111;color:#fff;cursor:pointer}` +
  `button:focus-visible{outline:3px solid #888;outline-offset:2px}</style></head><body>${body}</body></html>`;

/** The token is only echoed after TOKEN_RE has matched, so it cannot carry markup. */
export function confirmPage(token: string): string {
  if (!TOKEN_RE.test(token)) return resultPage(false, 'This link is not valid.');
  return page(
    'Confirm your email',
    `<h1>Confirm your email</h1><p>Press the button to confirm this address and send your licence request to the photographer.</p>` +
      `<form method="post" action="/api/verify/${token}"><button type="submit">Confirm my email</button></form>`,
  );
}

export function resultPage(ok: boolean, message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return page(ok ? 'Email confirmed' : 'Link problem', `<h1>${ok ? 'Email confirmed' : 'Link problem'}</h1><p>${safe}</p>`);
}

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

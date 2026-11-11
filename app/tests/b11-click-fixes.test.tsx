// @vitest-environment jsdom
// Click review findings 2, 4, 5, 6, 9, 10 and 11 (docs/reviews/b11-build-click.md). Findings 1 and 2 were also seen in a browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '@/app/login/login-screen';
import { STATUS_MEANING } from '@/components/creator/explain';
import { RequestResult } from '@/components/creator/request-sheet';
import { totalHint } from '@/components/creator/typed-total';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/deals', useSearchParams: () => new URLSearchParams() }));
afterEach(cleanup);



describe('finding 2: the request sheet', () => {
  it('following the card\'s link tells the sheet to close and reset', () => {
    const onLeave = vi.fn();
    render(<RequestResult result={{ posted: { briefId: 'b1', state: 'extracted', autopilot: 'sent' }, view: null }} onAnother={() => {}} onLeave={onLeave} />);
    const link = screen.getByRole('link', { name: 'Open the deal room' });
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe('finding 4: the first screen names where the quote came from', () => {
  it('links the post, and does not call the words verified', () => {
    const html = renderToStaticMarkup(<LoginScreen demo />);
    expect(html).toContain('r/WeddingPhotography');
    expect(html).toContain('href="https://www.reddit.com/r/WeddingPhotography/comments/1u7ekn1/');
    expect(html.toLowerCase()).not.toContain('verified');
  });
});

describe('findings 5, 6 and 11: claims', () => {
  const source = readFileSync(join(process.cwd(), 'components/client/client-experience.tsx'), 'utf8');
  const readme = readFileSync(join(process.cwd(), '..', 'README.md'), 'utf8');


  it('the public page states the rule instead of a measured-looking 100%', () => {
    const hero = readFileSync(join(process.cwd(), 'components/client/globe-hero.tsx'), 'utf8');
    expect(hero).toContain('Files unlock only after PayPal confirms payment.');
    expect(source).not.toContain('PayPal-verified unlocks');
    expect(source).not.toContain('value: 100');
  });

  it('the public README names the model and server-side toolkit, and keeps demo credentials private', () => {
    expect(readme).toContain('Gemini extracts');
    expect(readme).toContain('server-side Agent Toolkit');
    expect(readme).toContain('Testing credentials belong only in private submission notes');
  });
});

describe('findings 9 and 10: copy', () => {
  it('the approve hint asks for what the field takes', () => {
    expect(totalHint('', 90000, false).text).toBe('Type 900.00 to approve.');
    expect(totalHint('90', 90000, false).text).toBe('Type 900.00 to approve.');
    expect(totalHint('900', 90000, false).tone).toBe('match');
  });

  it('a rejected deal does not promise an edit will clear it', () => {
    expect(STATUS_MEANING.rejected!.next).not.toContain('unless the deal is edited');
  });
});

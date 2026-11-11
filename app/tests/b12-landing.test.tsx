import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Home from '@/app/page';

describe('B12 Part A: public landing', () => {
  it('renders the product, ordered process and both destinations without redirecting or fetching data', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('Your work.');
    expect(html).toContain('priced from your rate card');
    expect(html).toContain('when PayPal confirms payment');
    expect(html).toContain('href="/c/imani"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="#main"');
    expect(html).toContain('href="#process"');
    expect(html).toContain('id="process"');
    expect(html).toContain('How it works');
    expect(html).toContain('Reviewing this entry? Start with');
    expect(html).toContain('landing-review');
    expect(html).toContain('sign in with the demo login');
    expect(html).toContain('You: paste the brief.');
    expect(html).toContain('The agent: prices and invoices.');
    expect(html).toContain('PayPal: confirms the payment.');
    expect(html).toContain('Sign in to your workspace');
    expect(html).toContain('data-slot="separator"');
    expect(html).not.toContain('For creators');
    expect(html).toContain('id="main"');
    expect(html).toContain('<ol>');
    expect(html.indexOf('Bring the brief')).toBeLessThan(html.indexOf('Price from your rate card'));
    expect(html.indexOf('Price from your rate card')).toBeLessThan(html.indexOf('PayPal confirms. The file unlocks.'));
    expect(html).toContain('Coffee being poured');
    expect(html).not.toContain('/dev/');
  });
});

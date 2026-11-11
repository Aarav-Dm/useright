import Link from 'next/link';
import manifest from '@/public/portfolio/imani/photos.json';
import '@/components/client/glass.css';

export const metadata = { title: 'Photo credits · UseRight Agent' };

export default function CreditsPage() {
  return <div className="theme-glass min-h-screen px-6 py-12">
    <main className="mx-auto max-w-3xl">
      <Link href="/c/imani" className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Back to Imani’s portfolio</Link>
      <h1 className="g-display mt-10 text-6xl">Photo credits</h1>
      <p className="mt-6 max-w-prose leading-relaxed g-muted">Imani is a demonstration portfolio. These photographs are credited to their source photographers, not to Imani. The demo’s rate card illustrates a licensing workflow; it does not replace the source photo’s licence.</p>
      <p className="mt-4 max-w-prose leading-relaxed g-muted">The source and licence links below come from our photo records. We have not independently rechecked every attribution or licence. Follow the source links to check the current terms before using a photograph.</p>
      <ol className="mt-10 divide-y divide-white/10">
        {manifest.photos.map((p) => <li key={p.num} className="py-6">
          <h2 className="text-xl">{p.title}</h2>
          <p className="mt-2 g-muted">Photographer in source record: {p.photographer || 'Unknown'}</p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <a className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4" href={p.sourceUrl}>Photo source for {p.title}</a>
            <a className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4" href={p.licenceUrl}>Recorded licence: {p.num === '11' ? 'CC0 1.0' : 'Unsplash License'}</a>
          </div>
        </li>)}
      </ol>
    </main>
  </div>;
}

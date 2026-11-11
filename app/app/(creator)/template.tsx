import type { ReactNode } from 'react';

// A template remounts on every navigation, so each creator page fades and rises 8px once when it opens
// (CSS keyframes in globals.css `.dash-enter`; fades only under reduced motion; no JavaScript needed).
export default function CreatorTemplate({ children }: { children: ReactNode }) {
  return <div className="dash-enter">{children}</div>;
}

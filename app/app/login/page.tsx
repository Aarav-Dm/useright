// /login. On the server so DEMO_MODE is read at request time, for the one demo-mode line (review b9 5). No auth bypass.
import { demoMode } from '@/lib/clock';
import { LoginScreen } from './login-screen';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginScreen demo={demoMode()} />;
}

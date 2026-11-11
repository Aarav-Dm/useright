import { requireDevAccess } from '../access';
import DevIntakePage from './intake-screen';

export default async function DevIntake() {
  await requireDevAccess();
  return <DevIntakePage />;
}

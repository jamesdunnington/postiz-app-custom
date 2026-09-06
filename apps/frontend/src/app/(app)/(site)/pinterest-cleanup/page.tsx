import { PinterestCleanupComponent } from '@gitroom/frontend/components/pinterest-cleanup/pinterest.cleanup.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Cleanup`,
  description: '',
};

export default async function Page() {
  return <PinterestCleanupComponent />;
}

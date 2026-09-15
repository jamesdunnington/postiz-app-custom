import { PinterestMoveComponent } from '@gitroom/frontend/components/pinterest-move/pinterest.move.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Pin Move`,
  description: '',
};

export default async function Page() {
  return <PinterestMoveComponent />;
}

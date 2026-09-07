import { PinterestBoardCreationComponent } from '@gitroom/frontend/components/pinterest-boards/pinterest.board.creation.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Board Creation`,
  description: '',
};

export default async function Page() {
  return <PinterestBoardCreationComponent />;
}

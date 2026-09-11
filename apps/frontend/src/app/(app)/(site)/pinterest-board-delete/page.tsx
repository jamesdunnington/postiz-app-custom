import { PinterestBoardDeleteComponent } from '@gitroom/frontend/components/pinterest-board-delete/pinterest.board.delete.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Board Deletion`,
  description: '',
};

export default async function Page() {
  return <PinterestBoardDeleteComponent />;
}

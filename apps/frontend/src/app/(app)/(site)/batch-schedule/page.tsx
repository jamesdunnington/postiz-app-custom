import { BatchScheduleComponent } from '@gitroom/frontend/components/batch-schedule/batch.schedule.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Batch Scheduling`,
  description: '',
};

export default async function Page() {
  return <BatchScheduleComponent />;
}

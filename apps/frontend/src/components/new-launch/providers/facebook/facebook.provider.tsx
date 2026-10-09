'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import {
  FacebookDto,
  facebookBackgroundPresets,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/facebook.dto';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';

export const FacebookSettings = () => {
  const { register } = useSettings();

  return (
    <>
      <Input
        label={
          'Embedded URL (only for text Post)'
        }
        {...register('url')}
      />
      <Select
        label="Text background (text-only post, max 130 characters)"
        className="mb-5"
        hideErrors={true}
        {...register('text_format_preset_id', {
          value: '',
        })}
      >
        <option value="">None</option>
        {facebookBackgroundPresets.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </Select>
    </>
  );
};

export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: FacebookSettings,
  CustomPreviewComponent: undefined,
  dto: FacebookDto,
  checkValidity: async (posts, settings: any) => {
    if (settings?.text_format_preset_id && posts?.[0]?.length) {
      return 'A text background can only be used on a post without images or video.';
    }
    return true;
  },
  maximumCharacters: 63206,
});

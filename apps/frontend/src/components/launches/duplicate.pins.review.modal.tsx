'use client';

import { FC, useCallback, useState } from 'react';
import dayjs from 'dayjs';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useMediaDirectory } from '@gitroom/react/helpers/use.media.directory';
import { Button } from '@gitroom/react/form/button';
import { Integrations } from '@gitroom/frontend/components/launches/calendar.context';

export interface DuplicatePinPost {
  id: string;
  integrationId: string;
  publishDate: string;
  content: string;
  image: string | null;
}

export interface DuplicatePinGroup {
  key: string;
  posts: DuplicatePinPost[];
}

const firstImagePath = (image: string | null) => {
  try {
    const parsed = JSON.parse(image || '[]');
    return Array.isArray(parsed) ? parsed[0]?.path : undefined;
  } catch {
    return undefined;
  }
};

// Shown when Clean Calendar finds the same pin (same title + description +
// image) scheduled on more than one Pinterest account. Same-integration
// repeats are removed automatically before this ever opens — this modal
// only covers the ambiguous case where a human has to say which account
// keeps the pin.
export const DuplicatePinsReviewModal: FC<{
  groups: DuplicatePinGroup[];
  integrations: Integrations[];
  onResolved: () => void;
}> = (props) => {
  const modal = useModals();
  const fetch = useFetch();
  const toast = useToaster();
  const mediaDirectory = useMediaDirectory();

  const [keepByGroup, setKeepByGroup] = useState<Record<string, string>>(
    () =>
      props.groups.reduce((acc, group) => {
        // Default keep choice doesn't matter which copy - pre-select the
        // earliest-scheduled one, the user can pick any other instead.
        acc[group.key] = group.posts[0].id;
        return acc;
      }, {} as Record<string, string>)
  );
  const [submitting, setSubmitting] = useState(false);

  const findIntegration = useCallback(
    (id: string) => props.integrations.find((i) => i.id === id),
    [props.integrations]
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const removeIds = props.groups.flatMap((group) =>
        group.posts
          .filter((p) => p.id !== keepByGroup[group.key])
          .map((p) => p.id)
      );

      const response = await fetch('/integrations/resolve-duplicate-pins', {
        method: 'POST',
        body: JSON.stringify({ removeIds }),
      });

      if (response.ok) {
        const result = await response.json();
        toast.show(`✓ Removed ${result.removed} repeat pin(s)`, 'success');
        props.onResolved();
        modal.closeAll();
      } else {
        toast.show('Failed to remove repeat pins', 'warning');
      }
    } catch (error) {
      toast.show('Failed to remove repeat pins', 'warning');
    } finally {
      setSubmitting(false);
    }
  }, [keepByGroup, props.groups, props.onResolved]);

  return (
    <div className="rounded-[4px] border border-customColor6 bg-sixth p-[16px] relative w-full max-h-[80vh] overflow-y-auto">
      <div className="text-[18px] font-[600] mb-[8px]">
        Repeat pins found across different accounts
      </div>
      <div className="text-[13px] opacity-70 mb-[16px]">
        The same pin is scheduled on more than one Pinterest account. Pick
        which copy to keep in each group below — the rest will be removed.
      </div>

      <div className="flex flex-col gap-[16px]">
        {props.groups.map((group) => (
          <div
            key={group.key}
            className="border border-newTableBorder rounded-[8px] p-[12px]"
          >
            <div className="text-[13px] opacity-70 mb-[8px] line-clamp-2">
              {group.posts[0].content?.slice(0, 140) || '(no content)'}
            </div>
            <div className="flex flex-col gap-[8px]">
              {group.posts.map((post) => {
                const integration = findIntegration(post.integrationId);
                const imagePath = firstImagePath(post.image);
                return (
                  <label
                    key={post.id}
                    className="flex items-center gap-[10px] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name={`keep-${group.key}`}
                      checked={keepByGroup[group.key] === post.id}
                      onChange={() =>
                        setKeepByGroup((prev) => ({
                          ...prev,
                          [group.key]: post.id,
                        }))
                      }
                    />
                    {imagePath && (
                      <img
                        src={mediaDirectory.set(imagePath)}
                        alt=""
                        className="w-[36px] h-[36px] rounded-[4px] object-cover"
                      />
                    )}
                    {integration?.picture && (
                      <img
                        src={integration.picture}
                        alt=""
                        className="w-[20px] h-[20px] rounded-full"
                      />
                    )}
                    <span className="text-[13px]">
                      {integration?.name || post.integrationId}
                    </span>
                    <span className="text-[12px] opacity-60">
                      {dayjs(post.publishDate).format('YYYY-MM-DD HH:mm')}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-[20px] flex justify-end">
        <Button onClick={submit} disabled={submitting}>
          {submitting ? 'Removing...' : 'Remove duplicates'}
        </Button>
      </div>
    </div>
  );
};

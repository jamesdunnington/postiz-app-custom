'use client';

import { FC, useEffect, useState } from 'react';
import { useCustomProviderFunction } from '@gitroom/frontend/components/launches/helpers/use.custom.provider.function';
import { Select } from '@gitroom/react/form/select';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
export const PinterestBoard: FC<{
  name: string;
  onChange: (event: {
    target: {
      value: string;
      name: string;
    };
  }) => void;
}> = (props) => {
  const { onChange, name } = props;
  const t = useT();

  const customFunc = useCustomProviderFunction();
  const [orgs, setOrgs] = useState<undefined | any[]>();
  const { getValues } = useSettings();
  const [currentMedia, setCurrentMedia] = useState<string | undefined>();
  const [boardMissing, setBoardMissing] = useState<boolean>(false);
  
  const onChangeInner = (event: {
    target: {
      value: string;
      name: string;
    };
  }) => {
    setCurrentMedia(event.target.value);
    setBoardMissing(false); // Clear warning when user selects a board
    onChange(event);
  };
  
  useEffect(() => {
    // Load boards and then set the current media value
    customFunc.get('boards').then((data) => {
      setOrgs(data);
      
      // Set the current board value after boards are loaded
      const settings = getValues()[props.name];
      if (settings) {
        setCurrentMedia(settings);
        
        // Check if the saved board exists in the fetched boards
        const boardExists = data?.some((board: any) => board.id === settings);
        if (!boardExists && settings) {
          setBoardMissing(true);
          console.warn(`Board ID ${settings} not found in current boards list. It may have been deleted.`);
        }
      }
    });
  }, []);
  
  if (!orgs) {
    return null;
  }
  if (!orgs.length) {
    return 'No boards found, you have to create a board first';
  }
  return (
    <>
      <Select
        name={name}
        label="Select board"
        onChange={onChangeInner}
        value={currentMedia}
      >
        <option value="">{t('select_1', '--Select--')}</option>
        {boardMissing && currentMedia && (
          <option value={currentMedia} style={{ color: '#ef4444' }}>
            ⚠️ Previously selected board (may be deleted)
          </option>
        )}
        {orgs.map((org: any) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </Select>
      {boardMissing && (
        <div className="text-red-400 text-sm mt-1">
          ⚠️ The previously selected board is no longer available. Please select a new board.
        </div>
      )}
    </>
  );
};

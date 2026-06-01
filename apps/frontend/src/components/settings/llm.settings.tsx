'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { Autocomplete } from '@mantine/core';

interface LlmSettingsData {
  provider: 'openai' | 'openrouter';
  textModel: string;
  hasApiKey: boolean;
}

interface ModelOption {
  id: string;
  name: string;
}

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { value: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
] as const;

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4.1',
  openrouter: 'openai/gpt-4.1',
};

export const LlmSettings: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();

  const { data: settingsData, mutate: mutateSettings } =
    useSWR<LlmSettingsData>(
      '/settings/llm',
      async (url: string) => (await fetch(url)).json()
    );

  const [provider, setProvider] = useState<'openai' | 'openrouter'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('gpt-4.1');
  const [busy, setBusy] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  // Fetch live model list — keyed by provider so switching re-fetches immediately
  const { data: modelsData, isLoading: modelsLoading } = useSWR<{
    models: ModelOption[];
  }>(
    settingsData ? `/settings/llm/models?provider=${provider}` : null,
    async (url: string) => (await fetch(url)).json(),
    { revalidateOnFocus: false }
  );

  useEffect(() => {
    if (settingsData) {
      setProvider(settingsData.provider);
      setTextModel(settingsData.textModel);
    }
  }, [settingsData]);

  const onProviderChange = useCallback(
    (value: 'openai' | 'openrouter') => {
      setProvider(value);
      if (!textModel || textModel === DEFAULT_MODELS[provider]) {
        setTextModel(DEFAULT_MODELS[value]);
      }
      setModelSearch('');
    },
    [textModel, provider]
  );

  const onSave = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, textModel }),
      });
      if (!res.ok) throw new Error('save_failed');
      const updated = (await res.json()) as LlmSettingsData;
      mutateSettings(updated, false);
      setApiKey('');
      toast.show('AI settings saved', 'success');
    } catch {
      toast.show('Failed to save AI settings', 'warning');
    } finally {
      setBusy(false);
    }
  }, [fetch, mutateSettings, toast, provider, apiKey, textModel]);

  const autocompleteData = useMemo(() => {
    if (!modelsData?.models?.length) return [];
    return modelsData.models.map((m) => ({
      value: m.id,
      label: `${m.name}${m.id !== m.name ? ` (${m.id})` : ''}`,
    }));
  }, [modelsData]);

  const currentProvider = PROVIDER_OPTIONS.find((p) => p.value === provider);

  return (
    <div className="mt-[24px] border border-tableBorder p-[16px] flex flex-col gap-[12px]">
      <div className="text-[16px] font-semibold">AI / LLM Provider</div>
      <div className="text-[13px] opacity-70">
        Configure the AI provider and model used for post generation, chat
        agent, and content tools.
        {provider === 'openrouter' && (
          <span className="block mt-[4px] text-yellow-400">
            Note: Image generation (DALL-E) is disabled when using OpenRouter.
          </span>
        )}
      </div>

      {/* Provider toggle */}
      <div className="flex flex-col gap-[6px]">
        <label className="text-[13px] font-medium">Provider</label>
        <div className="flex gap-[8px]">
          {PROVIDER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onProviderChange(opt.value)}
              className={`px-[14px] py-[6px] rounded text-[13px] border transition-colors ${
                provider === opt.value
                  ? 'bg-forth border-forth text-white'
                  : 'bg-transparent border-tableBorder text-textColor hover:border-forth'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div className="flex flex-col gap-[6px]">
        <label className="text-[13px] font-medium">
          API Key
          {settingsData?.hasApiKey
            ? ' (saved — enter new key to replace)'
            : ''}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={currentProvider?.placeholder ?? 'API key'}
          className="bg-input border border-tableBorder rounded px-[12px] py-[8px] text-[13px] text-textColor w-full max-w-[420px] outline-none focus:border-forth"
          autoComplete="off"
        />
      </div>

      {/* Model selector */}
      <div className="flex flex-col gap-[6px]">
        <label className="text-[13px] font-medium">Text Model</label>
        {modelsLoading ? (
          <div className="text-[13px] opacity-50 py-[8px]">
            Loading models...
          </div>
        ) : autocompleteData.length > 0 ? (
          <div className="max-w-[420px]">
            <Autocomplete
              value={textModel}
              onChange={setTextModel}
              data={autocompleteData}
              placeholder={`Search models... (${autocompleteData.length} available)`}
              limit={20}
              styles={{
                input: {
                  backgroundColor: 'var(--color-input)',
                  borderColor: 'var(--color-tableBorder)',
                  color: 'var(--color-textColor)',
                  fontSize: '13px',
                  height: '38px',
                },
                dropdown: {
                  backgroundColor: 'var(--color-input)',
                  borderColor: 'var(--color-tableBorder)',
                },
                item: {
                  fontSize: '13px',
                  color: 'var(--color-textColor)',
                },
              }}
            />
          </div>
        ) : (
          <input
            type="text"
            value={textModel}
            onChange={(e) => setTextModel(e.target.value)}
            placeholder={DEFAULT_MODELS[provider]}
            className="bg-input border border-tableBorder rounded px-[12px] py-[8px] text-[13px] text-textColor w-full max-w-[420px] outline-none focus:border-forth"
          />
        )}
        <span className="text-[12px] opacity-60">
          {provider === 'openrouter'
            ? 'Type to search — models loaded live from OpenRouter'
            : 'Select or type an OpenAI model name'}
        </span>
      </div>

      <div className="mt-[4px]">
        <Button onClick={onSave} loading={busy}>
          Save AI settings
        </Button>
      </div>
    </div>
  );
};

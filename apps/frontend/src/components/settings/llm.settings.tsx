'use client';

import React, { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';

interface LlmSettingsData {
  provider: 'openai' | 'openrouter';
  textModel: string;
  hasApiKey: boolean;
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

  const { data, mutate } = useSWR<LlmSettingsData>(
    '/settings/llm',
    async (url: string) => (await fetch(url)).json()
  );

  const [provider, setProvider] = useState<'openai' | 'openrouter'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('gpt-4.1');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) {
      setProvider(data.provider);
      setTextModel(data.textModel);
    }
  }, [data]);

  const onProviderChange = useCallback(
    (value: 'openai' | 'openrouter') => {
      setProvider(value);
      if (!textModel || textModel === DEFAULT_MODELS[provider]) {
        setTextModel(DEFAULT_MODELS[value]);
      }
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
      mutate(updated, false);
      setApiKey('');
      toast.show('LLM settings saved', 'success');
    } catch {
      toast.show('Failed to save LLM settings', 'warning');
    } finally {
      setBusy(false);
    }
  }, [fetch, mutate, toast, provider, apiKey, textModel]);

  const currentProvider = PROVIDER_OPTIONS.find((p) => p.value === provider);

  return (
    <div className="mt-[24px] border border-tableBorder p-[16px] flex flex-col gap-[12px]">
      <div className="text-[16px] font-semibold">AI / LLM Provider</div>
      <div className="text-[13px] opacity-70">
        Configure the AI provider and model used for post generation, chat agent,
        and content tools. Supports OpenAI and OpenRouter.
        {provider === 'openrouter' && (
          <span className="block mt-[4px] text-yellow-400">
            Note: Image generation (DALL-E) is disabled when using OpenRouter.
          </span>
        )}
      </div>

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

      <div className="flex flex-col gap-[6px]">
        <label className="text-[13px] font-medium">
          API Key{data?.hasApiKey ? ' (saved — enter new key to replace)' : ''}
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

      <div className="flex flex-col gap-[6px]">
        <label className="text-[13px] font-medium">Text Model</label>
        <input
          type="text"
          value={textModel}
          onChange={(e) => setTextModel(e.target.value)}
          placeholder={DEFAULT_MODELS[provider]}
          className="bg-input border border-tableBorder rounded px-[12px] py-[8px] text-[13px] text-textColor w-full max-w-[420px] outline-none focus:border-forth"
        />
        <span className="text-[12px] opacity-60">
          {provider === 'openrouter'
            ? 'Use OpenRouter model ID, e.g. openai/gpt-4.1, anthropic/claude-3-5-sonnet, mistralai/mistral-7b-instruct'
            : 'Use OpenAI model name, e.g. gpt-4.1, gpt-4o, gpt-4o-mini'}
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

// src/components/settings/DataTab.tsx
// The Data tab: the banner naming where the options data comes from, and the user's Tradier and Finnhub keys, each
// saved trimmed 800 ms after the last edit, or when the tab unmounts with one pending.
import { useState } from 'react';
import { getPreference } from '../../lib/store.js';
import { savePreference } from '../../lib/storeEvents.js';
import { useAutoSave } from '../../hooks/useAutoSave.js';
import { useMarket } from '../../contexts/MarketContext.js';
import DataSourceBanner from './DataSourceBanner.js';
import SecretInput from './SecretInput.js';

/** A stored key as its input shows it, '' for none; a value that is not a string would reach .trim(). */
function readKey(name: 'data_tradier_key' | 'data_finnhub_key'): string {
  const value = getPreference(name);
  return typeof value === 'string' ? value : '';
}

// Each save is a savePreference, so the store bus tells this tab's readers (App's research flag follows the Finnhub
// key), where setPreference is silent by design. It also dispatches data-source-changed, which the market-data, quote
// and research hooks listen to instead of the bus.
function saveTradierKey(value: string): void {
  savePreference('data_tradier_key', value.trim() || null);
  window.dispatchEvent(new CustomEvent('data-source-changed'));
}

function saveFinnhubKey(value: string): void {
  savePreference('data_finnhub_key', value.trim() || null);
  window.dispatchEvent(new CustomEvent('data-source-changed'));
}

export default function DataTab() {
  const { dataSource } = useMarket();
  const [tradierKey, setTradierKey] = useState(() => readKey('data_tradier_key'));
  const [finnhubKey, setFinnhubKey] = useState(() => readKey('data_finnhub_key'));
  // Primed with the keys as loaded (the third argument is read once, at mount), so a loaded key is never written back.
  const { saved: tradierSaved, schedule: tradierSchedule } = useAutoSave(saveTradierKey, 800, tradierKey);
  const { saved: finnhubSaved, schedule: finnhubSchedule } = useAutoSave(saveFinnhubKey, 800, finnhubKey);

  return (
    <div className="p-6 space-y-4 fade-in">
      {/* Data source status banner */}
      <DataSourceBanner dataSource={dataSource} />

      {/* Tradier key */}
      <SecretInput
        label="Tradier API Key"
        value={tradierKey}
        onChange={(value) => { setTradierKey(value); tradierSchedule(value); }}
        placeholder="Paste for real-time data..."
        saved={tradierSaved}
      >
        {tradierKey.trim()
          ? 'Key saved — data will use Tradier on next refresh.'
          : dataSource === 'tradier'
            ? 'Currently using server-configured Tradier key.'
            : 'A free sandbox key works for testing — get one at tradier.com.'}
      </SecretInput>

      {/* Finnhub key */}
      <SecretInput
        label="Finnhub API Key"
        value={finnhubKey}
        onChange={(value) => { setFinnhubKey(value); finnhubSchedule(value); }}
        placeholder="Paste for news, earnings, analyst data..."
        saved={finnhubSaved}
      >
        {finnhubKey.trim()
          ? 'Key saved — enables news, earnings, analyst ratings, and technicals.'
          : 'Free API key from finnhub.io. Powers the Research panel and AI Co-Pilot context.'}
      </SecretInput>
    </div>
  );
}

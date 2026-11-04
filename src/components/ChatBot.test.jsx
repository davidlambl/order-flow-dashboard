// src/components/ChatBot.test.jsx — the AI Co-Pilot's shell, through the whole component: closed, it renders nothing;
// on the free tier it is the lock screen (its copy, Close chat, the access-token form at the lock's width, and Activate
// against validateToken); premium, the header (the model and ticker label, which follows a saved model name; the
// inspector toggle, the strategic-context editor, Clear behind a confirm, Settings and Close), the empty state's four
// suggestions, the model-context inspector (its size, its text, which a send carries exactly, its refresh once the
// editor closes or an import lands, and Copy) and the composer (Enter and Shift+Enter, Send, the streaming state,
// Suggest updates, the focus on open). Written against the one-file ChatBot.jsx on be2421f, before the shell used chat/, as the contract
// its decomposition (a shell over chat/ leaves and two hooks) must keep, so every test is a pin, and none asserts what
// the two designs do differently. The TIMESTAMP is read only with the Date frozen, where both print the frozen
// instant, never how often it moves (today on every render, in the decomposed inspector once a minute). The inspector
// is read after the editor has closed or an import has landed, never right after a save (today it refreshes when the
// chat next renders, the decomposed one on the save itself). The lock's form is found by its placeholder, its button
// and the width it sits in, never by its own classes; its network sentence is matched by its stem, and it is never
// edited while a token is being validated. The focus is asserted on open, never after an unlock.
// The recipes are the PR 3 attack stage's (attack-chat-report.md: the shell, stream and tests lenses). The chat renders
// under StrictMode, as main.jsx renders App. askLLM answers through the fetch recorder with a body the test drives, a
// fresh one per request, while validateToken goes on to MSW; streams run on real timers, with the animation frames
// queued by hand where a pin needs streamed text on screen. Only the Copy reset takes a fake clock, and the inspector's
// text is compared with the Date alone frozen.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import ChatBot from './ChatBot.jsx';
import { server } from '../test/setup.js';
import { withContexts } from '../test/contexts.jsx';
import { installFetchRecorder } from '../../test/helpers/fetch.js';
import { emitStoreChanged, setChatHistory, setPreference } from '../lib/store.js';
import { savePreference } from '../lib/storeEvents.js';

const FN = 'http://localhost:3000/.netlify/functions';

/** Enough MarketData for the shell: the ticker and no figures. */
const DATA = { ticker: 'AVGO', kpis: {}, gexByStrike: [], flowHistory: [] };

/** A complete MarketData, TickerContext and LiveQuote (types/market.ts), for the pin that compares the whole context. */
const MARKET_DATA = {
  ticker: 'AVGO',
  provider: 'cboe',
  delay: '15-min delayed',
  spotPrice: 100,
  priceChange: 1.25,
  priceChangePct: 1.27,
  kpis: {
    netPremium: 1_250_000, callPremium: 3_500_000, putPremium: 2_250_000, darkPoolPct: 38.5, maxPain: 98,
    putCallRatio: 0.82, maxPainExpiry: '2026-09-25', putCallOIRatio: 0.91,
    callVolume: 50_000, putVolume: 41_000, callOI: 250_000, putOI: 227_500,
  },
  gexByStrike: [
    { strike: 95, callGex: 1_000_000, putGex: -3_000_000, gex: -2_000_000 },
    { strike: 100, callGex: 6_000_000, putGex: -1_000_000, gex: 5_000_000 },
    { strike: 105, callGex: 4_000_000, putGex: -500_000, gex: 3_500_000 },
  ],
  lastUpdated: '2026-09-25T14:59:30.000Z',
  flowHistory: [
    { date: '2026-09-24', netPremium: 800_000, cumPremium: 800_000, callVolume: 45_000, putVolume: 38_000 },
    { date: '2026-09-25', netPremium: 1_250_000, cumPremium: 2_050_000, callVolume: 50_000, putVolume: 41_000 },
  ],
  fallbackReason: null,
  iv30: 31.4,
  lastTradeTime: '2026-09-25T10:59:30',
  totalOptionsCount: 4200,
  expiries: ['2026-09-25', '2026-10-02'],
};

const TICKER_CONTEXT = {
  ticker: 'AVGO',
  news: [
    { headline: 'Broadcom extends its AI deal', summary: '', source: 'Reuters', url: 'https://example.com/n1', datetime: '2026-09-25T13:30:00.000Z', sentiment: 0.4 },
    { headline: 'Chip stocks slip', summary: '', source: 'Bloomberg', url: 'https://example.com/n2', datetime: '2026-09-24T03:30:00.000Z', sentiment: -0.2 },
    { headline: 'No-date item', summary: '', source: 'AP', url: 'https://example.com/n3', datetime: null, sentiment: null },
  ],
  earnings: { date: '2026-09-27', epsEstimate: 1.5, epsActual: 1.6, revenueEstimate: 12_300_000_000, revenueActual: 12_100_000_000, quarter: null, year: null, surprise: 0.1 },
  analysts: {
    consensus: { strongBuy: 5, buy: 10, hold: 3, sell: 1, strongSell: 0, period: '2026-09-01' },
    priceTarget: { mean: 120, median: 125, high: 150, low: 90 },
  },
  technicals: { sma50: 95, sma200: 85, rsi14: 72.3, currentPrice: 100, fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 70 },
  fundamentals: {
    marketCap: 650_000, peRatio: 35.2, forwardPE: 28.1, dividendYield: 1.2, beta: 1.1, revenueGrowthQuarterly: 20.5,
    epsGrowthQuarterly: 15, grossMargin: 75.3, operatingMargin: 45.1, roeTTM: 30.2, debtToEquity: 1, freeCashFlowTTM: 1,
    revenuePerShareTTM: 1,
  },
  marketNews: [
    { headline: 'Stocks rally', source: 'Reuters', url: 'https://example.com/m1', datetime: '2026-09-25T02:00:00.000Z' },
    { headline: 'No date', source: 'AP', url: 'https://example.com/m2', datetime: null },
  ],
  marketQuotes: {
    SPY: { label: 'S&P 500', price: 520.1, change: 2.3, changePct: 0.45, previousClose: 517.8 },
    VIX: { label: 'VIX', price: 18.25, change: -0.5, changePct: -2.67, previousClose: 18.75 },
  },
  errors: {},
};

/** 1.5 % over the snapshot's spot while both sessions are closed: the context takes its dual-recommendation path. */
const LIVE_QUOTE = {
  ticker: 'AVGO', current: 101.5, previousClose: 100, changePercent: 1.5, timestamp: Date.parse('2026-09-25T15:00:00Z'),
  source: 'yahoo-regular',
};

const EMPTY_STATE = 'Ask questions about AVGO order flow, gamma, or positioning.';
const SUGGESTIONS = [
  'What does the GEX profile suggest?',
  'Is the flow bullish or bearish?',
  'Where are key support/resistance levels?',
  'Summarize the dark pool activity.',
];

const encoder = new TextEncoder();
const anthropicText = (text) => `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

/** An askLLM body the test drives chunk by chunk; `state.cancelled` records the reason a reader cancelled it with. */
function controlledStream() {
  let ctl;
  const state = { cancelled: null };
  const body = new ReadableStream({ start(c) { ctl = c; }, cancel(reason) { state.cancelled = reason ?? 'cancelled'; } });
  return {
    state,
    response: () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Provider': 'anthropic', 'X-Request-Id': 'q1' } }),
    text: (t) => ctl.enqueue(encoder.encode(anthropicText(t))),
    end: (reason = 'end_turn') => { ctl.enqueue(encoder.encode(`data: {"type":"message_delta","delta":{"stop_reason":"${reason}"}}\n\n`)); ctl.close(); },
    providerError: (msg) => ctl.enqueue(encoder.encode(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${msg}"}}\n\n`)),
  };
}

/**
 * Animation frames queued by hand: requestAnimationFrame only queues, cancelAnimationFrame drops, run() calls the
 * queue inside act. Real timers only; restoreMocks restores both before the next test.
 */
function manualFrames() {
  const frames = new Map();
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { const id = next++; frames.set(id, cb); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  return {
    pending: () => frames.size,
    run: () => act(() => { const cbs = [...frames.values()]; frames.clear(); for (const cb of cbs) cb(performance.now()); }),
  };
}

/**
 * validateToken as the function answers it: 'good…' is a pro token, 'down' a failed request, 'html' a 200 that is not
 * JSON, any other the 401 of an expired token.
 */
const serveTokens = () => server.use(http.post(`${FN}/validateToken`, async ({ request }) => {
  const { token } = await request.json();
  if (token === 'down') return HttpResponse.error();
  if (token === 'html') return new HttpResponse('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  return token.startsWith('good')
    ? HttpResponse.json({ valid: true, tier: 'pro', sub: 'u1', expiresAt: '2026-11-01T00:00:00.000Z', requestId: 'v1' })
    : HttpResponse.json({ valid: false, error: 'Token expired', code: 'TOKEN_EXPIRED', requestId: 'v2' }, { status: 401 });
}));

/** The chat under both providers and StrictMode, as App renders it: open, premium, on DATA, unless overridden. */
const chatUi = ({ isOpen = true, onClose = () => {}, onOpenSettings = () => {}, market = {}, auth = { isPremium: true } } = {}) => (
  <StrictMode>
    {withContexts(
      <ChatBot isOpen={isOpen} onClose={onClose} onOpenSettings={onOpenSettings} costBasis={90} shares={100} />,
      { market: { data: DATA, ...market }, auth },
    )}
  </StrictMode>
);

/** The fetch recorder: every request, askLLM's answered by a fresh controlledStream, any other passed on to MSW. */
let rec;
/** askLLM's reply bodies, one per request, in order. */
let streams;

const box = () => screen.getByPlaceholderText('Ask about the flow...');
/** The elements showing `text`, the composer holding it as a draft left out. */
const bubbles = (text) => screen.queryAllByText(text).filter((el) => el.tagName !== 'TEXTAREA');
/** The model context as the inspector shows it. */
const inspected = () => document.querySelector('pre').textContent;
/** Request `i` as the chat sent it (every request of a test that sends goes to askLLM). */
const sent = (i = 0) => JSON.parse(rec.calls[i].init.body);

/** Types `text` and presses Enter; resolves once its request is out. */
async function send(text) {
  const before = rec.calls.length;
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(rec.calls).toHaveLength(before + 1));
}

/** Ends reply `i` with `text`, then waits for Send to come back, so the reply's last updates land inside the wait. */
async function reply(i, text) {
  act(() => { streams[i].text(text); streams[i].end(); });
  await screen.findByLabelText('Send message');
}

/** A listener counting auth-changed until the test ends. */
function listenForAuth() {
  const listener = vi.fn();
  window.addEventListener('auth-changed', listener);
  onTestFinished(() => window.removeEventListener('auth-changed', listener));
  return listener;
}

describe('ChatBot', () => {
  beforeEach(() => {
    streams = [];
    const viaMsw = globalThis.fetch; // the dom setup's fetch, which hands validateToken to MSW
    rec = installFetchRecorder();
    rec.setFetch((url, init) => {
      if (!String(url).endsWith('/askLLM')) return viaMsw(url, init);
      const stream = controlledStream();
      streams.push(stream);
      return Promise.resolve(stream.response());
    });
  });

  afterEach(() => rec.uninstall());

  it('Pin: closed, the chat renders nothing, on either tier', () => {
    const { container, rerender } = render(chatUi({ isOpen: false }));
    expect(container).toBeEmptyDOMElement();
    rerender(chatUi({ isOpen: false, auth: { isPremium: false } }));
    expect(container).toBeEmptyDOMElement();
  });

  it("Pin: on the free tier the chat is the lock screen: its heading, the Premium Feature sentence and the token form at the lock's width", () => {
    render(chatUi({ auth: { isPremium: false } }));
    expect(screen.getByText('AI Co-Pilot')).toBeInTheDocument();
    expect(screen.getByText('Premium Feature')).toBeInTheDocument();
    expect(screen.getByText('The AI Co-Pilot provides institutional-grade analysis of options flow and gamma exposure.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Paste access token...').closest('.max-w-xs')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask about the flow...')).toBeNull();
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
  });

  it('Pin: Close chat on the lock screen calls onClose', () => {
    const onClose = vi.fn();
    render(chatUi({ onClose, auth: { isPremium: false } }));
    fireEvent.click(screen.getByLabelText('Close chat'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Pin: Activate on the lock screen stores an accepted token trimmed and dispatches auth-changed once', async () => {
    serveTokens();
    const authChanged = listenForAuth();
    const user = userEvent.setup();
    render(chatUi({ auth: { isPremium: false } }));
    await user.type(screen.getByPlaceholderText('Paste access token...'), '  good  ');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(localStorage.getItem('access_token')).toBe('good'));
    expect(authChanged).toHaveBeenCalledTimes(1);
  });

  it('Pin: Activate on the lock screen shows why validateToken refused a token, and stores nothing', async () => {
    serveTokens();
    const authChanged = listenForAuth();
    const user = userEvent.setup();
    render(chatUi({ auth: { isPremium: false } }));
    await user.type(screen.getByPlaceholderText('Paste access token...'), 'stale');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Token expired')).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authChanged).not.toHaveBeenCalled();
  });

  // Matched by its stem: the activation form the lock is to share with Settings and the gates adds "Try again.".
  it('Pin: Activate on the lock screen says it could not validate the token when the request fails or the answer is not JSON, and stores nothing', async () => {
    serveTokens();
    const authChanged = listenForAuth();
    const user = userEvent.setup();
    render(chatUi({ auth: { isPremium: false } }));
    const input = screen.getByPlaceholderText('Paste access token...');
    await user.type(input, 'down');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Could not validate token/)).toBeInTheDocument();

    // An edit clears the sentence, so the second one is the second answer's.
    await user.clear(input);
    await user.type(input, 'html');
    expect(screen.queryByText(/Could not validate token/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Could not validate token/)).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
    expect(authChanged).not.toHaveBeenCalled();
  });

  // The label's parts are text of one element: App.test.jsx finds it by the whole sentence.
  it('Pin: the header names the model and the ticker, and follows a model name saved through the store', () => {
    render(chatUi());
    expect(screen.getByText('Default · AVGO context')).toBeInTheDocument();
    act(() => { savePreference('ai_model_name', 'Claude X'); });
    expect(screen.getByText('Claude X · AVGO context')).toBeInTheDocument();
    expect(screen.queryByText('Default · AVGO context')).toBeNull();
  });

  it('Pin: Settings and Close chat in the header call onOpenSettings and onClose', () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(chatUi({ onClose, onOpenSettings }));
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close chat'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('Pin: the inspect button shows the model context in place of the messages, the composer kept, and a second click hides it', () => {
    render(chatUi());
    expect(document.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByLabelText('Inspect model context'));
    expect(inspected()).toMatch(/^TICKER: AVGO\n/);
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
    expect(box()).toBeEnabled();

    fireEvent.click(screen.getByLabelText('Inspect model context'));
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it('Pin: the Pencil opens the strategic-context editor, and its close button closes it', async () => {
    render(chatUi());
    expect(screen.queryByPlaceholderText(/Paste your strategic context/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Edit strategic context'));
    expect(await screen.findByPlaceholderText(/Paste your strategic context/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close strategic context editor'));
    expect(screen.queryByPlaceholderText(/Paste your strategic context/)).toBeNull();
  });

  it('Pin: Clear chat history shows once the chat has a message, and clears it only when confirmed', async () => {
    render(chatUi());
    const clear = () => screen.queryByLabelText('Clear chat history');
    expect(clear()).toBeNull();
    await send('Q1');
    expect(clear()).toBeInTheDocument();
    await reply(0, 'A1');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(clear());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bubbles('Q1')).toHaveLength(1);
    expect(screen.getByText('A1')).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(clear());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(bubbles('Q1')).toHaveLength(0);
    expect(screen.queryByText('A1')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
    expect(clear()).toBeNull();
  });

  // jsdom has no layout: a typed draft leaves the composer's height at '0px', and a send sets it back to 'auto'.
  it('Pin: the empty state offers four suggestions, and a click sends one in place of the draft and resets the composer', async () => {
    render(chatUi());
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
    for (const suggestion of SUGGESTIONS) expect(screen.getByRole('button', { name: suggestion })).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: 'A draft\nover two lines' } });
    expect(box().style.height).not.toBe('auto');

    fireEvent.click(screen.getByRole('button', { name: SUGGESTIONS[1] }));
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(sent().messages.at(-1)).toEqual({ role: 'user', content: SUGGESTIONS[1] });
    expect(box()).toHaveValue('');
    expect(box().style.height).toBe('auto');
    await reply(0, 'A1');
  });

  // The Date alone is faked: the stream, the frames and the waits stay on real timers.
  it('Pin: the inspector counts the characters it shows, and shows exactly the financialContext a send carries (the Date frozen)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T15:00:00Z'));
    onTestFinished(() => { vi.useRealTimers(); });
    setPreference('strategic_context', 'My thesis');
    render(chatUi({
      market: { data: MARKET_DATA, tickerContext: TICKER_CONTEXT, liveQuote: LIVE_QUOTE, marketOpen: false, optionsMarketOpen: false },
    }));
    fireEvent.click(screen.getByLabelText('Inspect model context'));
    const shown = inspected();
    expect(shown).toMatch(/^TICKER: AVGO\nTIMESTAMP: 2026-09-25T15:00:00\.000Z\n/);
    expect(shown).toContain('Scenario #2 (If Live Price Holds)');
    expect(shown).toContain('STRATEGIC CONTEXT (user-provided):\nMy thesis');
    expect(screen.getByText(`Model Context (${shown.length.toLocaleString()} chars)`)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();

    await send('Q');
    expect(sent().financialContext).toBe(shown);
    await reply(0, 'A');
  });

  it('Pin: the inspector shows a strategic-context edit once the editor closes, and an import that changed everything', async () => {
    setPreference('strategic_context', 'Plan A');
    const user = userEvent.setup();
    render(chatUi());
    fireEvent.click(screen.getByLabelText('Inspect model context'));
    expect(inspected()).toContain('STRATEGIC CONTEXT (user-provided):\nPlan A');

    fireEvent.click(screen.getByLabelText('Edit strategic context'));
    await user.type(await screen.findByPlaceholderText(/Paste your strategic context/), ' plus B');
    fireEvent.click(screen.getByLabelText('Close strategic context editor'));
    expect(inspected()).toContain('STRATEGIC CONTEXT (user-provided):\nPlan A plus B');

    act(() => {
      localStorage.setItem('strategic_context', JSON.stringify('Imported C'));
      emitStoreChanged();
    });
    expect(inspected()).toContain('STRATEGIC CONTEXT (user-provided):\nImported C');
  });

  // user-event's setup() installs its own clipboard over whatever is there, so the spy comes after it.
  it('Pin: Copy puts the model context on the clipboard and reads Copied, then Copy again 1.5 s later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(chatUi());
    await user.click(screen.getByLabelText('Inspect model context'));
    const shown = inspected();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(shown);
    expect(await navigator.clipboard.readText()).toBe(shown);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('Pin: Enter sends the draft and Shift+Enter does not, Send sends it too, and Send is disabled while the draft is blank', async () => {
    render(chatUi());
    const sendButton = () => screen.getByLabelText('Send message');
    expect(sendButton()).toBeDisabled();
    fireEvent.change(box(), { target: { value: '   ' } });
    expect(sendButton()).toBeDisabled();
    fireEvent.change(box(), { target: { value: 'Q1' } });
    expect(sendButton()).toBeEnabled();

    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(box()).toHaveValue('Q1');
    expect(bubbles('Q1')).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);

    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(sent(0).messages.at(-1)).toEqual({ role: 'user', content: 'Q1' });
    expect(bubbles('Q1')).toHaveLength(1);
    await reply(0, 'A1');

    fireEvent.change(box(), { target: { value: 'Q2' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(rec.calls).toHaveLength(2));
    expect(sent(1).messages.at(-1)).toEqual({ role: 'user', content: 'Q2' });
    await reply(1, 'A2');
  });

  it('Pin: while a reply streams, its first text on screen included, the composer is disabled and empty and Stop stands in for Send', async () => {
    const frames = manualFrames();
    render(chatUi());
    fireEvent.change(box(), { target: { value: 'Q1' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(rec.calls).toHaveLength(1));
    const expectStreaming = () => {
      expect(box()).toBeDisabled();
      expect(box()).toHaveValue('');
      expect(box().style.height).toBe('auto');
      expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();
      expect(screen.queryByLabelText('Send message')).toBeNull();
    };
    expectStreaming();

    act(() => { streams[0].text('Part one'); });
    await waitFor(() => expect(frames.pending()).toBe(1));
    frames.run();
    expect(screen.getByText('Part one')).toBeInTheDocument();
    expectStreaming();

    act(() => { streams[0].end(); });
    await screen.findByLabelText('Send message');
    expect(box()).toBeEnabled();
    expect(screen.queryByLabelText('Stop generating')).toBeNull();
  });

  it('Pin: Suggest updates shows once an assistant reply exists, and not while a reply streams', async () => {
    setChatHistory('AVGO', [{ role: 'user', content: 'Unanswered' }]);
    render(chatUi());
    const suggest = () => screen.queryByLabelText('Suggest updates to Strategic Context');
    expect(bubbles('Unanswered')).toHaveLength(1);
    expect(suggest()).toBeNull();

    await send('Q1');
    expect(suggest()).toBeNull();
    await reply(0, 'A1');
    expect(suggest()).toBeInTheDocument();

    await send('Q2');
    expect(suggest()).toBeNull();
    await reply(1, 'A2');
    expect(suggest()).toBeInTheDocument();
  });

  it('Pin: opening the chat focuses the composer', () => {
    const { rerender } = render(chatUi({ isOpen: false }));
    rerender(chatUi());
    expect(document.activeElement).toBe(box());
  });
});

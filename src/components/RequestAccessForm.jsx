// src/components/RequestAccessForm.jsx
// The request for early access (a Netlify form posted to the site root): name and e-mail side by side on a premium
// gate (`compact`), stacked in Settings, then the optional message. Each field has a visible label tied to it by an id
// from useId (the placeholders stay as hints), and the name and e-mail fields say what they hold (autocomplete). A
// failed request is announced as an alert (it is the request's, not a field's); a sent one replaces the form with a
// status.
import { useState, useCallback, useId } from 'react';
import { Send, LoaderCircle, CircleCheckBig, CircleAlert } from 'lucide-react';

const LABEL = 'block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5';

export default function RequestAccessForm({ compact }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const id = useId();

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;

    setStatus('sending');
    setError('');

    const body = new URLSearchParams({
      'form-name': 'access-request',
      'bot-field': '',
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
    });

    try {
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Server returned ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`
        );
      }

      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setError(
        err?.message?.startsWith('Server returned')
          ? err.message
          : 'Network error — are you running locally? Netlify Forms only works on the deployed site.'
      );
    }
  }, [name, email, message]);

  if (status === 'sent') {
    return (
      <div role="status" className="flex items-center gap-2 py-3 px-3 rounded-lg bg-[var(--color-bull)]/10 border border-[var(--color-bull)]/20">
        <CircleCheckBig size={14} className="text-[var(--color-bull)] shrink-0" />
        <span className="text-xs text-[var(--color-bull)]">
          Request sent — you'll hear back soon.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5">
      <div className={compact ? 'flex gap-2' : 'space-y-2'}>
        <div className={compact ? 'flex-1 min-w-0' : undefined}>
          <label htmlFor={`${id}-name`} className={LABEL}>Name</label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            required
            className="w-full bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
        </div>
        <div className={compact ? 'flex-1 min-w-0' : undefined}>
          <label htmlFor={`${id}-email`} className={LABEL}>Email address</label>
          <input
            id={`${id}-email`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            autoComplete="email"
            required
            className="w-full bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-message`} className={LABEL}>Message (optional)</label>
        <textarea
          id={`${id}-message`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Why you'd like access (optional)"
          rows={2}
          className="w-full bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none leading-relaxed"
        />
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
          <CircleAlert size={10} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <button
        type="submit"
        disabled={!name.trim() || !email.trim() || status === 'sending'}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {status === 'sending' ? (
          <><LoaderCircle size={12} className="animate-spin" /> Sending...</>
        ) : (
          <><Send size={12} /> Request Access</>
        )}
      </button>
    </form>
  );
}

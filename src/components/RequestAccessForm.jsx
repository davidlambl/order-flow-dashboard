// src/components/RequestAccessForm.jsx
import { useState, useCallback, useRef } from 'react';
import { Send, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

const COOLDOWN_MS = 60_000;

export default function RequestAccessForm({ compact }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const cooldownRef = useRef(null);

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

      if (!res.ok) throw new Error(`${res.status}`);

      setStatus('sent');
      cooldownRef.current = Date.now();
    } catch {
      setStatus('error');
      setError('Could not send request. Try again later.');
    }
  }, [name, email, message]);

  if (status === 'sent') {
    return (
      <div className="flex items-center gap-2 py-3 px-3 rounded-lg bg-[var(--color-bull)]/10 border border-[var(--color-bull)]/20">
        <CheckCircle size={14} className="text-[var(--color-bull)] shrink-0" />
        <span className="text-xs text-[var(--color-bull)]">
          Request sent — you'll hear back soon.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5">
      <div className={compact ? 'flex gap-2' : 'space-y-2'}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          required
          className={`${compact ? 'flex-1' : 'w-full'} bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors`}
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className={`${compact ? 'flex-1' : 'w-full'} bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors`}
        />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Why you'd like access (optional)"
        rows={2}
        className="w-full bg-[var(--color-surface-2)] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] rounded-lg px-3 py-2 border border-[var(--color-border-subtle)] outline-none focus:border-[var(--color-accent)] transition-colors resize-none leading-relaxed"
      />
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-bear)]">
          <AlertCircle size={10} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <button
        type="submit"
        disabled={!name.trim() || !email.trim() || status === 'sending'}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {status === 'sending' ? (
          <><Loader2 size={12} className="animate-spin" /> Sending...</>
        ) : (
          <><Send size={12} /> Request Access</>
        )}
      </button>
    </form>
  );
}

// src/components/LoginForm.jsx
// Passwordless magic link login via Supabase Auth.

import { useState } from 'react';
import { Activity } from 'lucide-react';
import { supabase } from '../lib/supabase';

const SEND_FAILED = 'Could not send the magic link.';

/**
 * @param {{ onSkip: () => void, notice?: string|null }} props
 *   notice: shown above the form, e.g. when the app could not check for an existing session
 */
export default function LoginForm({ onSkip, notice }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('sending');
    setErrorMsg('');
    // A thrown error (network down) must not leave the form stuck on "Sending..." (roadmap F10). The
    // link returns to this page, not the project's Site URL (D11); Supabase only honours a redirect
    // listed under Auth › URL Configuration › Redirect URLs and otherwise falls back to the Site URL.
    // (Nothing conditional inside the try/catch: the React Compiler cannot lower that yet.)
    let error;
    try {
      ({ error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      }));
    } catch (err) {
      error = err; // a network failure is thrown rather than returned
    }
    if (error) {
      setStatus('error');
      setErrorMsg(error.message || SEND_FAILED);
    } else {
      setStatus('sent');
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 text-blue-400">
          <Activity className="w-8 h-8" />
          <span className="text-2xl font-bold text-white">Order Flow</span>
        </div>

        {notice && status !== 'sent' && (
          <p role="status" className="text-gray-400 text-xs text-center leading-relaxed">
            {notice}
          </p>
        )}

        {status === 'sent' ? (
          <div className="bg-[#141926] border border-gray-700 rounded-lg p-6 text-center space-y-3">
            <p className="text-green-400 font-medium">Check your email</p>
            <p className="text-gray-400 text-sm">
              We sent a magic link to <span className="text-white">{email}</span>. Click it to sign in.
            </p>
            <button
              onClick={() => setStatus('idle')}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Try a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-[#141926] border border-gray-700 rounded-lg p-6 space-y-4">
            <p className="text-gray-400 text-sm text-center">
              Sign in to sync your data across devices
            </p>

            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#0a0e17] border border-gray-600 rounded-md px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
              autoFocus
              disabled={status === 'sending'}
            />

            {status === 'error' && (
              <p className="text-red-400 text-xs">{errorMsg}</p>
            )}

            <button
              type="submit"
              disabled={status === 'sending' || !email.trim()}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2 rounded-md transition-colors"
            >
              {status === 'sending' ? 'Sending...' : 'Send magic link'}
            </button>
          </form>
        )}

        <button
          onClick={onSkip}
          className="w-full text-sm text-gray-500 hover:text-gray-400 transition-colors"
        >
          Continue without signing in
        </button>
      </div>
    </div>
  );
}

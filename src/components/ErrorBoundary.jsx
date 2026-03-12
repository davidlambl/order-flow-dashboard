// src/components/ErrorBoundary.jsx
// Catches unhandled render errors and displays a recovery UI instead of a white screen.
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] p-6">
          <div className="max-w-md w-full text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <h1 className="text-xl font-semibold text-[var(--color-text)]">
              Something went wrong
            </h1>
            <p className="text-sm text-[var(--color-text-muted)]">
              An unexpected error occurred. Your data is safe — try reloading.
            </p>
            {this.state.error?.message && (
              <pre className="text-xs text-[var(--color-text-muted)] bg-[var(--color-surface)] rounded-lg p-3 overflow-x-auto text-left border border-[var(--color-border-subtle)]">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors"
            >
              Reload Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

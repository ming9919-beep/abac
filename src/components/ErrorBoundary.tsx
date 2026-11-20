import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global error boundary — catches any runtime render error (e.g. undefined
 * field access on a success screen) and shows a friendly fallback instead of
 * a blank white screen. The user can go home or reload.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught:', error, info.componentStack);
  }

  handleReload = () => {
    window.location.href = '/';
  };

  handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-[#F7F5FF] px-8 text-center">
        <div className="w-20 h-20 rounded-full bg-[#E8002D]/10 flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-10 h-10 text-[#E8002D]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h1 className="mt-5 text-[22px] font-extrabold text-gray-900">页面出现问题</h1>
        <p className="mt-2 text-[14px] text-gray-500 max-w-[280px] leading-relaxed">
          Something went wrong while rendering this page. Please return home and try again.
        </p>
        {this.state.error && (
          <p className="mt-3 text-[11px] text-gray-400 font-mono max-w-[300px] break-all">
            {this.state.error.message}
          </p>
        )}
        <div className="mt-8 flex gap-3">
          <button
            onClick={this.handleHome}
            className="px-6 py-3 rounded-2xl bg-[#7B4FE8] text-white font-bold text-[15px] active:opacity-80"
          >
            返回首页
          </button>
          <button
            onClick={this.handleReload}
            className="px-6 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-bold text-[15px] active:bg-gray-50"
          >
            刷新
          </button>
        </div>
      </div>
    );
  }
}

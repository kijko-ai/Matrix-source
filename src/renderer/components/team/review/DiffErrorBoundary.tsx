import { Component, type ReactNode } from 'react';

import { AlertTriangle } from 'lucide-react';

interface DiffErrorBoundaryProps {
  children: ReactNode;
  filePath: string;
  oldString?: string;
  newString?: string;
  onRetry?: () => void;
}

interface DiffErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class DiffErrorBoundary extends Component<DiffErrorBoundaryProps, DiffErrorBoundaryState> {
  constructor(props: DiffErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): DiffErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      '[DiffErrorBoundary] Error rendering diff for',
      this.props.filePath,
      error,
      errorInfo
    );
  }

  render(): JSX.Element {
    if (!this.state.hasError) {
      return <>{this.props.children}</>;
    }

    const { filePath, oldString, newString, onRetry } = this.props;
    const { error } = this.state;

    return (
      <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4">
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="size-4 text-red-400" />
          <span className="text-sm font-medium text-red-300">Failed to render diff view</span>
        </div>

        <p className="mb-3 text-xs text-red-300/80">
          {error?.message ?? 'An unexpected error occurred while rendering the diff.'}
        </p>

        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                onRetry();
              }}
              className="rounded bg-red-500/20 px-3 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/30"
            >
              Retry
            </button>
          )}
        </div>

        {(oldString || newString) && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-red-300/60 hover:text-red-300/80">
              Show raw diff data
            </summary>
            <div className="mt-2 max-h-60 overflow-auto rounded bg-surface p-2 font-mono text-xs text-text-muted">
              <div className="mb-1 text-text-secondary">File: {filePath}</div>
              {oldString && (
                <div className="mb-2">
                  <div className="mb-0.5 text-red-400">--- Original</div>
                  <pre className="whitespace-pre-wrap">{oldString.slice(0, 2000)}</pre>
                  {oldString.length > 2000 && (
                    <span className="text-text-muted">... ({oldString.length} chars total)</span>
                  )}
                </div>
              )}
              {newString && (
                <div>
                  <div className="mb-0.5 text-green-400">+++ Modified</div>
                  <pre className="whitespace-pre-wrap">{newString.slice(0, 2000)}</pre>
                  {newString.length > 2000 && (
                    <span className="text-text-muted">... ({newString.length} chars total)</span>
                  )}
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    );
  }
}

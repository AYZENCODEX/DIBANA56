import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AYZEN render error:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground px-6">
          <div className="max-w-md w-full text-center space-y-5">
            <div className="mx-auto w-14 h-14 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7 text-red-400" />
            </div>
            <div>
              <h1 className="font-mono font-bold text-lg tracking-tight text-foreground">Something went wrong</h1>
              <p className="font-mono text-xs text-muted-foreground mt-2">
                AYZEN hit an unexpected error while rendering this page. Try reloading — your data is safe.
              </p>
              {this.state.error?.message && (
                <p className="font-mono text-[10px] text-muted-foreground/50 mt-3 break-all bg-card border border-card-border rounded-lg px-3 py-2">
                  {this.state.error.message}
                </p>
              )}
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleReload}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg font-mono text-xs font-bold hover:opacity-90 transition-opacity"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reload
              </button>
              <button
                onClick={this.handleHome}
                className="flex items-center gap-2 px-4 py-2 border border-card-border rounded-lg font-mono text-xs hover:bg-muted/30 transition-colors"
              >
                <Home className="w-3.5 h-3.5" /> Go home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

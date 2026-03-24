/**
 * SearchBar - In-session search interface component.
 * Appears at the top of the chat view when Cmd+F is pressed.
 */

import { useEffect, useRef } from 'react';

import { useStore } from '@renderer/store';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

interface SearchBarProps {
  tabId?: string;
}

export const SearchBar = ({ tabId }: SearchBarProps): React.JSX.Element | null => {
  const {
    searchQuery,
    searchVisible,
    searchResultCount,
    currentSearchIndex,
    conversation,
    setSearchQuery,
    hideSearch,
    nextSearchResult,
    previousSearchResult,
  } = useStore(
    useShallow((s) => ({
      searchQuery: s.searchQuery,
      searchVisible: s.searchVisible,
      searchResultCount: s.searchResultCount,
      currentSearchIndex: s.currentSearchIndex,
      conversation: tabId
        ? (s.tabSessionData[tabId]?.conversation ?? s.conversation)
        : s.conversation,
      setSearchQuery: s.setSearchQuery,
      hideSearch: s.hideSearch,
      nextSearchResult: s.nextSearchResult,
      previousSearchResult: s.previousSearchResult,
    }))
  );

  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when search becomes visible
  useEffect(() => {
    if (searchVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [searchVisible]);

  // Handle keyboard shortcuts within search bar
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      hideSearch();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        previousSearchResult();
      } else {
        nextSearchResult();
      }
    }
  };

  if (!searchVisible) {
    return null;
  }

  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-lg">
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value, conversation)}
        onKeyDown={handleKeyDown}
        placeholder="Find in conversation..."
        className="w-48 rounded border border-border bg-surface-raised px-3 py-1.5 text-sm text-text focus:border-text-secondary focus:outline-none"
      />

      {/* Result count */}
      {searchQuery && (
        <span className="whitespace-nowrap text-xs text-text-secondary">
          {searchResultCount > 0
            ? `${currentSearchIndex + 1} of ${searchResultCount}`
            : 'No results'}
        </span>
      )}

      {/* Navigation buttons */}
      <div className="flex gap-0.5">
        <button
          onClick={previousSearchResult}
          disabled={searchResultCount === 0}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
          title="Previous result (Shift+Enter)"
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          onClick={nextSearchResult}
          disabled={searchResultCount === 0}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
          title="Next result (Enter)"
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      {/* Close button */}
      <button
        onClick={hideSearch}
        className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text"
        title="Close (Esc)"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};

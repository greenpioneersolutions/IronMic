import { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Mic, Sparkles, StickyNote, Users, ArrowRight, Loader2 } from 'lucide-react';
import { useAiChatStore, type AiSession } from '../stores/useAiChatStore';
import { useNotesStore } from '../stores/useNotesStore';
import { Card, PageHeader } from './ui';
import type { Entry } from '../types';

type ResultType = 'dictation' | 'ai-session' | 'note' | 'meeting';

interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  preview: string;
  time: number;
  sessionId?: string;
  tags?: string[];
  meta?: string; // e.g. "3 speakers · 25 min"
}

interface MeetingSession {
  id: string;
  started_at: string;
  ended_at?: string;
  speaker_count: number;
  summary?: string;
  action_items?: string;
  total_duration_seconds?: number;
  raw_transcript?: string;
  structured_output?: string;
  detected_app?: string;
  name?: string;
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ResultType | 'all'>('all');
  const [searching, setSearching] = useState(false);
  const [serverResults, setServerResults] = useState<SearchResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessions = useAiChatStore((s) => s.sessions);
  const notes = useNotesStore((s) => s.notes);

  // Listen for voice dictation results when recording from search page
  useEffect(() => {
    const handler = (e: Event) => {
      const { text, sourceApp } = (e as CustomEvent).detail;
      if (sourceApp === 'search' && text) {
        setQuery(text.trim());
      }
    };
    window.addEventListener('ironmic:dictation-complete', handler);
    return () => window.removeEventListener('ironmic:dictation-complete', handler);
  }, []);

  // Debounce the query
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  // Server-side searches (entries via FTS5 + meetings via LIKE)
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) { setServerResults([]); return; }

    let cancelled = false;
    setSearching(true);

    (async () => {
      const results: SearchResult[] = [];

      // FTS5 entry search
      try {
        const entries: Entry[] = await window.ironmic.listEntries({ limit: 30, offset: 0, search: q, archived: false });
        for (const entry of entries || []) {
          const isAi = entry.sourceApp?.startsWith('ai-chat');
          const text = entry.polishedText || entry.rawTranscript;
          results.push({
            type: 'dictation',
            id: entry.id,
            title: isAi ? 'AI Dictation' : 'Dictation',
            preview: text.slice(0, 150),
            time: new Date(entry.createdAt).getTime(),
            tags: entry.tags ? safeParseArray(entry.tags) : undefined,
          });
        }
      } catch { /* entries search failed — continue */ }

      // Meeting search
      try {
        const meetingsJson = await window.ironmic.meetingSearch(q, 20);
        const meetings: MeetingSession[] = JSON.parse(meetingsJson || '[]');
        for (const m of meetings) {
          const duration = m.total_duration_seconds ? `${Math.round(m.total_duration_seconds / 60)} min` : '';
          const speakerInfo = m.speaker_count > 0 ? `${m.speaker_count} speaker${m.speaker_count !== 1 ? 's' : ''}` : '';
          const meta = [speakerInfo, duration].filter(Boolean).join(' · ');
          const preview = m.summary || m.raw_transcript?.slice(0, 150) || m.action_items?.slice(0, 150) || 'No transcript';
          results.push({
            type: 'meeting',
            id: m.id,
            title: m.name || (m.detected_app ? `${m.detected_app.charAt(0).toUpperCase() + m.detected_app.slice(1)} Meeting` : 'Meeting'),
            preview,
            time: new Date(m.started_at).getTime(),
            meta,
          });
        }
      } catch { /* meeting search failed — continue */ }

      if (!cancelled) setServerResults(results);
      if (!cancelled) setSearching(false);
    })();

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Client-side searches (AI sessions + notes — in localStorage)
  const clientResults = useMemo(() => {
    const q = debouncedQuery.toLowerCase().trim();
    if (!q) return [];

    const results: SearchResult[] = [];

    // AI sessions
    for (const session of sessions) {
      const allText = session.messages.map((m) => m.content).join(' ').toLowerCase();
      if (allText.includes(q) || session.title.toLowerCase().includes(q)) {
        const lastUserMsg = [...session.messages].reverse().find((m) => m.role === 'user');
        results.push({
          type: 'ai-session',
          id: session.id,
          sessionId: session.id,
          title: session.title,
          preview: lastUserMsg?.content.slice(0, 150) || 'AI conversation',
          time: session.updatedAt,
          meta: `${session.messages.length} messages`,
        });
      }
    }

    // Notes
    for (const note of notes) {
      if (
        note.title.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q) ||
        note.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        results.push({
          type: 'note',
          id: note.id,
          title: note.title || 'Untitled',
          preview: note.content.slice(0, 150).replace(/\n/g, ' ') || 'Empty note',
          time: note.updatedAt,
          tags: note.tags,
        });
      }
    }

    return results;
  }, [debouncedQuery, sessions, notes]);

  // Merge all results, sort by time
  const allResults = useMemo(() => {
    const merged = [...serverResults, ...clientResults];
    merged.sort((a, b) => b.time - a.time);
    return merged;
  }, [serverResults, clientResults]);

  const filtered = activeFilter === 'all' ? allResults : allResults.filter((r) => r.type === activeFilter);

  const counts = useMemo(() => ({
    all: allResults.length,
    dictation: allResults.filter((r) => r.type === 'dictation').length,
    meeting: allResults.filter((r) => r.type === 'meeting').length,
    'ai-session': allResults.filter((r) => r.type === 'ai-session').length,
    note: allResults.filter((r) => r.type === 'note').length,
  }), [allResults]);

  const handleNavigate = (result: SearchResult) => {
    if (result.type === 'ai-session' && result.sessionId) {
      window.dispatchEvent(new CustomEvent('ironmic:open-ai-session', { detail: result.sessionId }));
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'ai' }));
    } else if (result.type === 'note') {
      useNotesStore.getState().setActiveNote(result.id);
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'notes' }));
    } else if (result.type === 'meeting') {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'meetings' }));
    } else {
      window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'main' }));
    }
  };

  const typeIcons: Record<ResultType, typeof Mic> = {
    dictation: Mic,
    meeting: Users,
    'ai-session': Sparkles,
    note: StickyNote,
  };

  const typeColors: Record<ResultType, string> = {
    dictation: 'text-iron-accent-light bg-iron-accent/10',
    meeting: 'text-blue-400 bg-blue-500/10',
    'ai-session': 'text-purple-400 bg-purple-500/10',
    note: 'text-emerald-400 bg-emerald-500/10',
  };

  const typeLabels: Record<ResultType, string> = {
    dictation: 'Dictation',
    meeting: 'Meeting',
    'ai-session': 'AI Chat',
    note: 'Note',
  };

  const filterTabs: (ResultType | 'all')[] = ['all', 'dictation', 'meeting', 'ai-session', 'note'];

  return (
    <div className="flex flex-col h-full">
      <PageHeader icon={Search} title="Search" description="Find anything across dictations, meetings, chats, and notes" />

      <div className="px-6 pt-4 pb-4">
        <div className="max-w-2xl mx-auto">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-iron-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across dictations, meetings, AI chats, and notes..."
              className="w-full text-base bg-iron-surface border border-iron-border rounded-2xl pl-12 pr-4 py-3.5 text-iron-text placeholder:text-iron-text-muted focus:outline-none focus:border-iron-accent/50 focus:shadow-glow transition-all"
              autoFocus
            />
            {searching && (
              <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-iron-text-muted animate-spin" />
            )}
          </div>

          {/* Filter tabs */}
          {debouncedQuery.trim() && (
            <div className="flex items-center gap-1.5 mt-3">
              {filterTabs.map((filter) => {
                const count = counts[filter];
                // Hide tabs with 0 results (except "all")
                if (filter !== 'all' && count === 0) return null;
                return (
                  <button
                    key={filter}
                    onClick={() => setActiveFilter(filter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      activeFilter === filter
                        ? 'bg-iron-accent/15 text-iron-accent-light border border-iron-accent/20'
                        : 'text-iron-text-muted hover:bg-iron-surface-hover'
                    }`}
                  >
                    {filter === 'all' ? 'All' : typeLabels[filter]}
                    {' '}
                    <span className="text-iron-text-muted/70">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="max-w-2xl mx-auto space-y-2">
          {!query.trim() && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-14 h-14 rounded-2xl bg-iron-accent/10 flex items-center justify-center mb-4">
                <Search className="w-7 h-7 text-iron-accent-light" />
              </div>
              <p className="text-sm font-medium text-iron-text">Search Everything</p>
              <p className="text-xs text-iron-text-muted mt-1.5 max-w-[320px] leading-relaxed">
                Find anything across your dictations, meeting notes, AI conversations, and written notes — all in one place.
              </p>
              <div className="flex items-center gap-3 mt-4">
                {(['dictation', 'meeting', 'ai-session', 'note'] as ResultType[]).map((type) => {
                  const Icon = typeIcons[type];
                  return (
                    <div key={type} className="flex items-center gap-1.5 text-[10px] text-iron-text-muted">
                      <div className={`w-5 h-5 rounded flex items-center justify-center ${typeColors[type]}`}>
                        <Icon className="w-3 h-3" />
                      </div>
                      {typeLabels[type]}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {debouncedQuery.trim() && !searching && filtered.length === 0 && (
            <div className="text-center py-16">
              <p className="text-sm text-iron-text-muted">No results for &ldquo;{debouncedQuery}&rdquo;</p>
            </div>
          )}

          {filtered.map((result) => {
            const Icon = typeIcons[result.type];
            return (
              <button
                key={`${result.type}-${result.id}`}
                onClick={() => handleNavigate(result)}
                className="w-full text-left group"
              >
                <Card variant="default" padding="md" className="hover:border-iron-border-hover transition-colors">
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${typeColors[result.type]}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-iron-text-muted">
                          {typeLabels[result.type]}
                        </span>
                        <span className="text-[10px] text-iron-text-muted">
                          {new Date(result.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                        {result.meta && (
                          <span className="text-[10px] text-iron-text-muted">· {result.meta}</span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-iron-text mt-0.5 truncate">{result.title}</p>
                      <p className="text-xs text-iron-text-muted mt-0.5 line-clamp-2">
                        <HighlightedPreview text={result.preview} query={debouncedQuery} />
                      </p>
                      {result.tags && result.tags.length > 0 && (
                        <div className="flex gap-1 mt-1.5">
                          {result.tags.slice(0, 4).map((t) => (
                            <span key={t} className="text-[10px] px-1.5 py-0 rounded-full bg-iron-accent/10 text-iron-accent-light">#{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <ArrowRight className="w-4 h-4 text-iron-text-muted/0 group-hover:text-iron-text-muted transition-colors flex-shrink-0 mt-2" />
                  </div>
                </Card>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Highlight matching text in the preview */
function HighlightedPreview({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  const idx = lowerText.indexOf(lowerQuery);

  if (idx === -1) return <>{text}</>;

  // Show context around the match
  const matchEnd = idx + lowerQuery.length;
  const before = text.slice(Math.max(0, idx - 40), idx);
  const match = text.slice(idx, matchEnd);
  const after = text.slice(matchEnd, matchEnd + 80);
  const prefix = idx > 40 ? '...' : '';
  const suffix = matchEnd + 80 < text.length ? '...' : '';

  return (
    <>
      {prefix}{before}
      <span className="text-iron-accent-light font-medium bg-iron-accent/10 rounded px-0.5">{match}</span>
      {after}{suffix}
    </>
  );
}

function safeParseArray(json: string): string[] {
  try { return JSON.parse(json); } catch { return []; }
}

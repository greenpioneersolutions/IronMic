import { useState, useRef } from 'react';
import { Clock, Users, Trash2, ChevronDown, ChevronRight, Mic, FileText, AlignLeft, Sparkles, Loader2, Pencil, Check } from 'lucide-react';
import { Card } from './ui';
import { ShareMenu } from './ShareMenu';

interface MeetingSession {
  id: string;
  started_at: string;
  ended_at?: string;
  speaker_count: number;
  summary?: string;
  action_items?: string;
  total_duration_seconds?: number;
  template_id?: string;
  structured_output?: string;
  detected_app?: string;
  raw_transcript?: string;
  name?: string;
}

interface Props {
  session: MeetingSession;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
}

export function MeetingSessionCard({ session, onDelete, onRename }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(session.name || '');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSummarizeNow = async () => {
    if (!session.raw_transcript) return;
    setSummarizing(true);
    try {
      // Use user's custom prompt or default
      let promptText = 'Summarize this meeting transcript. List key decisions and action items.';
      try {
        const custom = await window.ironmic.getSetting('meeting_summary_prompt');
        if (custom && custom.trim()) promptText = custom.trim();
      } catch { /* use default */ }
      const prompt = `${promptText}\n\n${session.raw_transcript}`;
      const result = await window.ironmic.polishText(prompt);
      if (result && !result.startsWith(promptText.slice(0, 30))) {
        setLocalSummary(result);
        // Try to save it back to the session
        try {
          await window.ironmic.meetingEnd(
            session.id,
            session.speaker_count,
            result,
            undefined,
            session.total_duration_seconds || 0,
            undefined,
          );
        } catch { /* save failed, still show locally */ }
      } else {
        setLocalSummary('__STUB__');
      }
    } catch (err) {
      console.error('[MeetingSessionCard] Summarize failed:', err);
      setLocalSummary('__STUB__');
    }
    setSummarizing(false);
  };

  const date = new Date(session.started_at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const duration = session.total_duration_seconds
    ? `${Math.round(session.total_duration_seconds / 60)} min`
    : '';

  // Try to parse structured output
  let structuredSections: Array<{ key: string; title: string; content: string }> | null = null;
  if (session.structured_output) {
    try {
      const parsed = JSON.parse(session.structured_output);
      structuredSections = parsed.sections || null;
    } catch { /* fallback to summary */ }
  }

  return (
    <Card variant="default" padding="none" className="animate-fade-in">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-iron-surface-hover/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-iron-accent/10 flex items-center justify-center flex-shrink-0">
            <Mic className="w-4 h-4 text-iron-accent-light" />
          </div>
          <div className="min-w-0">
            {editing ? (
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <input
                  ref={inputRef}
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      onRename?.(session.id, editName);
                      setEditing(false);
                    }
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  className="text-sm font-medium text-iron-text bg-iron-surface border border-iron-accent/30 rounded px-2 py-0.5 w-48 focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={(e) => { e.stopPropagation(); onRename?.(session.id, editName); setEditing(false); }}
                  className="p-1 text-green-400 hover:bg-green-500/10 rounded"
                >
                  <Check className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group">
                <p className="text-sm font-medium text-iron-text truncate">
                  {session.name || (session.detected_app
                    ? `${session.detected_app.charAt(0).toUpperCase() + session.detected_app.slice(1)} Meeting`
                    : 'Meeting')}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditName(session.name || '');
                    setEditing(true);
                  }}
                  className="p-0.5 text-iron-text-muted hover:text-iron-text opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Rename meeting"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 text-[11px] text-iron-text-muted">
              <Clock className="w-3 h-3" />
              <span>{date}</span>
              {duration && <span>· {duration}</span>}
              {session.speaker_count > 0 && (
                <>
                  <Users className="w-3 h-3 ml-1" />
                  <span>{session.speaker_count}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <ShareMenu meetingId={session.id} text={session.summary} />
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
            className="p-1.5 rounded-lg text-iron-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {expanded ? <ChevronDown className="w-4 h-4 text-iron-text-muted" /> : <ChevronRight className="w-4 h-4 text-iron-text-muted" />}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-iron-border/50">
          {structuredSections ? (
            // Structured output from template
            structuredSections.map((section) => (
              <div key={section.key} className="pt-3">
                <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">
                  {section.title}
                </h4>
                <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                  {section.content}
                </div>
              </div>
            ))
          ) : (localSummary && localSummary !== '__STUB__') ? (
            <div className="pt-3">
              <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">Summary</h4>
              <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                {localSummary}
              </div>
            </div>
          ) : session.summary ? (
            <div className="pt-3">
              <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">Summary</h4>
              <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                {session.summary}
              </div>
            </div>
          ) : (
            // No summary — show analyze buttons
            <div className="pt-3 space-y-2">
              {session.raw_transcript ? (
                <>
                  <p className="text-xs text-iron-text-muted">
                    Transcript captured but not yet summarized. {localSummary === '__STUB__' ? 'The LLM model is not available — download it in Settings > Models to enable summarization.' : ''}
                  </p>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSummarizeNow(); }}
                    disabled={summarizing}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-iron-accent/15 text-iron-accent-light rounded-lg border border-iron-accent/20 hover:bg-iron-accent/25 transition-all disabled:opacity-50"
                  >
                    {summarizing ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Summarizing...</>
                    ) : (
                      <><Sparkles className="w-3 h-3" /> Summarize Now</>
                    )}
                  </button>
                </>
              ) : (
                <p className="text-xs text-iron-text-muted">No transcript or summary available.</p>
              )}
            </div>
          )}

          {session.action_items && !structuredSections && (
            <div>
              <h4 className="text-xs font-semibold text-iron-text-muted uppercase tracking-wider mb-1.5">Action Items</h4>
              <div className="text-sm text-iron-text leading-relaxed whitespace-pre-wrap">
                {session.action_items}
              </div>
            </div>
          )}

          {/* Raw transcript toggle */}
          {session.raw_transcript && (
            <div className="pt-2 border-t border-iron-border/50">
              <button
                onClick={(e) => { e.stopPropagation(); setShowRaw(!showRaw); }}
                className="flex items-center gap-1.5 text-[11px] text-iron-accent-light hover:underline"
              >
                {showRaw ? <FileText className="w-3 h-3" /> : <AlignLeft className="w-3 h-3" />}
                {showRaw ? 'Hide raw transcript' : 'Show raw transcript'}
              </button>
              {showRaw && (
                <div className="mt-2 px-3 py-2.5 bg-iron-surface-active rounded-lg text-xs text-iron-text-secondary leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {session.raw_transcript}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

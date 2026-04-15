import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mic, Settings, List, Sparkles, StickyNote, Search, Home,
  ChevronLeft, ChevronRight, Volume2, PenTool, BarChart3, Users,
} from 'lucide-react';
import { RecordingIndicator } from './RecordingIndicator';
import { Timeline } from './Timeline';
import { SettingsPanel } from './SettingsPanel';
import { AIChat } from './AIChat';
import { NotesPage } from './NotesPage';
import { SearchPage } from './SearchPage';
import { WelcomePage } from './WelcomePage';
import { ListenPage } from './ListenPage';
import { DictatePage } from './DictatePage';
import { AnalyticsPage } from './AnalyticsPage';
import { MeetingPage } from './MeetingPage';
import { useTheme } from '../hooks/useTheme';
import { GpuPrompt } from './GpuPrompt';
import { SessionLock } from './SessionLock';
import { ToastContainer } from './Toast';
import { useRecordingStore } from '../stores/useRecordingStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useEntryStore } from '../stores/useEntryStore';
import { useToastStore } from '../stores/useToastStore';
import iconSmall from '../assets/icon-64.png';
import micIdle from '../assets/mic-idle.png';
import micRecording from '../assets/mic-recording.png';
import micProcessing from '../assets/mic-processing.png';
import micSuccess from '../assets/mic-success.png';

type Page = 'home' | 'main' | 'ai' | 'dictate' | 'listen' | 'notes' | 'search' | 'analytics' | 'meetings' | 'settings';

interface NavItem {
  id: Page;
  label: string;
  icon: typeof Mic;
  section: 'workspace' | 'discover';
}

/** Page metadata for top bar title and icons */
const PAGE_META: Record<Page, { label: string; icon: typeof Mic }> = {
  home: { label: 'Home', icon: Home },
  main: { label: 'Timeline', icon: List },
  ai: { label: 'AI Assistant', icon: Sparkles },
  dictate: { label: 'Dictate', icon: PenTool },
  listen: { label: 'Listen', icon: Volume2 },
  notes: { label: 'Notes', icon: StickyNote },
  search: { label: 'Search', icon: Search },
  analytics: { label: 'Analytics', icon: BarChart3 },
  meetings: { label: 'Meetings', icon: Users },
  settings: { label: 'Settings', icon: Settings },
};

const NAV_ITEMS: NavItem[] = [
  // Workspace: primary creation tools
  { id: 'home', label: 'Home', icon: Home, section: 'workspace' },
  { id: 'dictate', label: 'Dictate', icon: PenTool, section: 'workspace' },
  { id: 'main', label: 'Timeline', icon: List, section: 'workspace' },
  { id: 'notes', label: 'Notes', icon: StickyNote, section: 'workspace' },
  { id: 'meetings', label: 'Meetings', icon: Users, section: 'workspace' },
  // Discover: consumption & exploration
  { id: 'search', label: 'Search', icon: Search, section: 'discover' },
  { id: 'ai', label: 'AI Assistant', icon: Sparkles, section: 'discover' },
  { id: 'listen', label: 'Listen', icon: Volume2, section: 'discover' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, section: 'discover' },
];

export function Layout() {
  const [page, setPage] = useState<Page>('home');
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sessionTimeout, setSessionTimeout] = useState('off');
  const [micVisualState, setMicVisualState] = useState<'idle' | 'recording' | 'processing' | 'success'>('idle');
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { handleHotkeyPress, state: recordingState } = useRecordingStore();
  const { loadSettings, aiEnabled } = useSettingsStore();
  const { refresh } = useEntryStore();
  const pageRef = useRef(page);
  pageRef.current = page;

  useTheme();

  useEffect(() => {
    window.ironmic.getSetting('security_session_timeout').then((v) => {
      if (v) setSessionTimeout(v);
    }).catch(() => {});
  }, []);

  const handleRecord = useCallback(() => {
    // Track which page started the recording so results route back there
    const pageSourceMap: Record<Page, string | undefined> = {
      home: undefined,
      main: 'timeline',
      ai: 'ai-chat',
      dictate: 'dictate',
      listen: 'listen',
      notes: 'notes',
      search: 'search',
      analytics: undefined,
      meetings: undefined,
      settings: undefined,
    };
    handleHotkeyPress(pageSourceMap[pageRef.current]);
  }, [handleHotkeyPress]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // On startup: sync Rust recording state — if Rust thinks it's recording but JS is idle, force-reset
  useEffect(() => {
    (async () => {
      try {
        const isRecording = await window.ironmic.isRecording();
        if (isRecording) {
          console.warn('[startup] Rust was still recording — force-resetting');
          await window.ironmic.resetRecording();
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // One-time migration
  useEffect(() => {
    (async () => {
      try {
        const migrated = await window.ironmic.getSetting('migration_tag_ai_done');
        if (migrated === 'true') return;
        await window.ironmic.tagUntaggedEntries('ai-chat');
        await window.ironmic.setSetting('migration_tag_ai_done', 'true');
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    const cleanup = window.ironmic.onHotkeyPressed(() => handleRecord());
    return cleanup;
  }, [handleRecord]);
  // Sync recording pipeline state → visual mic state with success flash
  useEffect(() => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);

    if (recordingState === 'recording') {
      setMicVisualState('recording');
    } else if (recordingState === 'processing') {
      setMicVisualState('processing');
    } else if (recordingState === 'idle') {
      // If we were processing, show success briefly
      if (micVisualState === 'processing') {
        setMicVisualState('success');
        successTimerRef.current = setTimeout(() => setMicVisualState('idle'), 15000);
      } else if (micVisualState !== 'success') {
        setMicVisualState('idle');
      }
      refresh();
    }
  }, [recordingState]);

  useEffect(() => {
    if (!aiEnabled && page === 'ai') setPage('home');
  }, [aiEnabled, page]);

  // Show a toast when dictation completes on a page that doesn't display the result inline
  useEffect(() => {
    const handler = (e: Event) => {
      const { preview, sourceApp } = (e as CustomEvent).detail;
      const currentPage = pageRef.current;

      // These pages show the result directly — no toast needed
      const inlinePages: Page[] = ['main', 'dictate'];
      if (sourceApp?.startsWith('ai-chat')) inlinePages.push('ai');

      if (inlinePages.includes(currentPage)) return;

      const showToast = useToastStore.getState().show;
      showToast({
        message: `Dictation saved: "${preview}"`,
        type: 'success',
        durationMs: 10000,
        action: {
          label: 'View in Timeline',
          onClick: () => {
            setPage('main');
          },
        },
      });
    };
    const emptyHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const isHallucination = detail?.reason === 'hallucination';
      useToastStore.getState().show({
        message: isHallucination
          ? `Recording discarded — mic may not be picking up your voice clearly.`
          : 'No speech detected in recording.',
        type: 'warning',
        durationMs: 8000,
        action: {
          label: 'Check Mic Settings',
          onClick: () => {
            setPage('settings');
            // Small delay to let settings render, then switch to Input tab
            setTimeout(() => window.dispatchEvent(new CustomEvent('ironmic:settings-tab', { detail: 'input' })), 100);
          },
        },
      });
    };

    const lowAudioHandler = () => {
      useToastStore.getState().show({
        message: 'Low audio detected — your mic may not be picking up clearly. Check Settings > Input.',
        type: 'warning',
        durationMs: 6000,
        action: {
          label: 'Check Mic',
          onClick: () => {
            setPage('settings');
            setTimeout(() => window.dispatchEvent(new CustomEvent('ironmic:settings-tab', { detail: 'input' })), 100);
          },
        },
      });
    };

    window.addEventListener('ironmic:dictation-complete', handler);
    window.addEventListener('ironmic:dictation-empty', emptyHandler);
    window.addEventListener('ironmic:dictation-low-audio', lowAudioHandler);
    return () => {
      window.removeEventListener('ironmic:dictation-complete', handler);
      window.removeEventListener('ironmic:dictation-empty', emptyHandler);
      window.removeEventListener('ironmic:dictation-low-audio', lowAudioHandler);
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent).detail as string;
      if (['home', 'main', 'ai', 'dictate', 'listen', 'notes', 'search', 'analytics', 'meetings', 'settings'].includes(target)) {
        setPage(target as Page);
      }
    };
    window.addEventListener('ironmic:navigate', handler);
    return () => window.removeEventListener('ironmic:navigate', handler);
  }, []);

  const handleNavigate = useCallback((p: string) => setPage(p as Page), []);

  const workspaceItems = NAV_ITEMS.filter((n) => n.section === 'workspace');
  const discoverItems = NAV_ITEMS.filter((n) => n.section === 'discover' && (n.id !== 'ai' || aiEnabled));

  return (
    <div className="flex h-screen bg-iron-bg">
      {/* Sidebar */}
      <div className={`flex flex-col border-r border-iron-border bg-iron-surface transition-all duration-200 ${
        sidebarExpanded ? 'w-52' : 'w-16'
      }`}>
        {/* Mic shield button + brand */}
        <div className={`flex flex-col items-center pt-6 pb-3 ${sidebarExpanded ? 'px-4' : 'px-3'}`}>
          <MicShield state={micVisualState} onClick={handleRecord} expanded={sidebarExpanded} />
          {sidebarExpanded && (
            <div className="flex items-center gap-2 mt-2">
              <p className="text-xs font-bold text-iron-text">IronMic</p>
              <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                micVisualState === 'idle' ? 'text-iron-accent-light bg-iron-accent/10' :
                micVisualState === 'recording' ? 'text-red-400 bg-red-500/10' :
                micVisualState === 'processing' ? 'text-yellow-400 bg-yellow-500/10' :
                'text-emerald-400 bg-emerald-500/10'
              }`}>
                {micVisualState === 'idle' ? 'Ready' :
                 micVisualState === 'recording' ? 'Recording' :
                 micVisualState === 'processing' ? 'Processing' : 'Done'}
              </span>
            </div>
          )}
        </div>

        {/* Nav sections */}
        <nav className="flex-1 overflow-y-auto px-2 space-y-4">
          <NavSection label="Workspace" items={workspaceItems} page={page} setPage={setPage} expanded={sidebarExpanded} />
          <NavSection label="Discover" items={discoverItems} page={page} setPage={setPage} expanded={sidebarExpanded} />
        </nav>

        {/* Bottom: collapse toggle */}
        <div className="px-2 pb-3">
          <button
            onClick={() => setSidebarExpanded(!sidebarExpanded)}
            className="w-full flex items-center justify-center py-2 text-iron-text-muted hover:text-iron-text-secondary transition-colors"
            title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarExpanded ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div
          className="flex items-center justify-between px-5 py-2.5 border-b border-iron-border bg-iron-surface/50 backdrop-blur-sm"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Page title */}
          <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {page !== 'home' && (() => {
              const meta = PAGE_META[page];
              const Icon = meta.icon;
              return (
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-iron-text-muted" />
                  <span className="text-sm font-medium text-iron-text">{meta.label}</span>
                </div>
              );
            })()}
            <RecordingIndicator />
          </div>
          {/* Settings gear */}
          <button
            onClick={() => setPage('settings')}
            title="Settings"
            className={`p-1.5 rounded-lg transition-colors ${
              page === 'settings'
                ? 'bg-iron-accent/10 text-iron-accent-light'
                : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {page === 'main' && <GpuPrompt />}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {page === 'home' && <WelcomePage onNavigate={handleNavigate} />}
          {page === 'main' && <Timeline />}
          {page === 'ai' && <AIChat />}
          {page === 'dictate' && <DictatePage />}
          {page === 'listen' && <ListenPage />}
          {page === 'notes' && <NotesPage />}
          {page === 'search' && <SearchPage />}
          {page === 'analytics' && <AnalyticsPage />}
          {page === 'meetings' && <MeetingPage />}
          {page === 'settings' && <SettingsPanel />}
        </div>
      </div>

      <ToastContainer />
      <SessionLock timeoutSetting={sessionTimeout} />
    </div>
  );
}

// ── Nav components ──

function NavSection({ label, items, page, setPage, expanded }: {
  label: string; items: NavItem[]; page: Page; setPage: (p: Page) => void; expanded: boolean;
}) {
  return (
    <div>
      {expanded && (
        <p className="text-[10px] font-semibold text-iron-text-muted uppercase tracking-wider px-3 mb-1">{label}</p>
      )}
      <div className="space-y-0.5">
        {items.map((item) => (
          <NavButton key={item.id} item={item} active={page === item.id} onClick={() => setPage(item.id)} expanded={expanded} />
        ))}
      </div>
    </div>
  );
}

function NavButton({ item, active, onClick, expanded }: {
  item: NavItem; active: boolean; onClick: () => void; expanded: boolean;
}) {
  const Icon = item.icon;

  if (!expanded) {
    return (
      <button
        onClick={onClick}
        title={item.label}
        className={`w-full flex items-center justify-center py-2.5 rounded-xl transition-all duration-150 ${
          active
            ? 'bg-iron-accent/10 text-iron-accent-light shadow-glow'
            : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
        }`}
      >
        <Icon className="w-5 h-5" />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150 ${
        active
          ? 'bg-iron-accent/10 text-iron-accent-light shadow-glow'
          : 'text-iron-text-muted hover:text-iron-text-secondary hover:bg-iron-surface-hover'
      }`}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

// ── Mic Shield Button ──

const MIC_IMAGES = {
  idle: micIdle,
  recording: micRecording,
  processing: micProcessing,
  success: micSuccess,
};

function MicShield({ state, onClick, expanded }: {
  state: 'idle' | 'recording' | 'processing' | 'success';
  onClick: () => void;
  expanded: boolean;
}) {
  const size = expanded ? 'w-20 h-14' : 'w-12 h-9';

  return (
    <button
      onClick={onClick}
      className={`relative ${size} rounded-xl overflow-hidden transition-all duration-300 group`}
      title={
        state === 'idle' ? 'Click to record' :
        state === 'recording' ? 'Click to stop recording' :
        state === 'processing' ? 'Processing your audio...' :
        'Dictation complete!'
      }
    >
      {/* Glow backdrop */}
      <div className={`absolute inset-0 rounded-xl transition-all duration-700 ${
        state === 'idle' ? 'shadow-[0_0_15px_rgba(30,111,255,0.15)]' :
        state === 'recording' ? 'shadow-[0_0_20px_rgba(239,68,68,0.3)]' :
        state === 'processing' ? 'shadow-[0_0_20px_rgba(234,179,8,0.25)]' :
        'shadow-[0_0_20px_rgba(34,197,94,0.3)]'
      }`} />

      {/* Shield images — crossfade */}
      {Object.entries(MIC_IMAGES).map(([key, src]) => (
        <img
          key={key}
          src={src}
          alt=""
          className={`absolute inset-0 w-full h-full object-contain transition-all duration-500 ${
            key === state ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          } ${
            key === state && state === 'processing' ? 'animate-pulse-slow' : ''
          } ${
            key === state && state === 'recording' ? 'animate-glow-recording' : ''
          }`}
        />
      ))}

      {/* Hover overlay (idle only) */}
      {state === 'idle' && (
        <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-all duration-200 rounded-xl" />
      )}
    </button>
  );
}

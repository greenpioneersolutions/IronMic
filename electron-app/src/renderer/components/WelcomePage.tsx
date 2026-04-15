import { useState, useEffect } from 'react';
import {
  Mic, Sparkles, Volume2, Download, CheckCircle,
  Shield, Search, StickyNote, List, Users, PenTool, BarChart3,
} from 'lucide-react';
import { Card } from './ui';
import micIdleImg from '../assets/mic-idle.png';

interface ModelInfo {
  downloaded: boolean;
  sizeLabel: string;
  name: string;
  purpose: string;
}

interface WelcomePageProps {
  onNavigate: (page: string) => void;
}

export function WelcomePage({ onNavigate }: WelcomePageProps) {
  const [models, setModels] = useState<Record<string, ModelInfo>>({});
  const [loading, setLoading] = useState(true);
  const [hotkey, setHotkey] = useState('Cmd+Shift+V');
  const [visitCount, setVisitCount] = useState(0);

  useEffect(() => {
    loadStatus();
    // Track visit count for conditional security badge
    const count = parseInt(localStorage.getItem('ironmic-home-visits') || '0', 10);
    setVisitCount(count + 1);
    localStorage.setItem('ironmic-home-visits', String(count + 1));
  }, []);

  async function loadStatus() {
    try {
      const [status, hk, ttsReady] = await Promise.all([
        window.ironmic.getModelStatus(),
        window.ironmic.getSetting('hotkey_record'),
        window.ironmic.isTtsModelReady(),
      ]);
      if (hk) setHotkey(hk.replace('CommandOrControl', 'Cmd'));

      const files = status?.files || {};
      setModels({
        whisper: { downloaded: files.whisper?.downloaded || false, sizeLabel: '~1.5 GB', name: 'Whisper', purpose: 'Speech' },
        llm: { downloaded: files.llm?.downloaded || false, sizeLabel: '~4.4 GB', name: 'Mistral 7B', purpose: 'Text Cleanup' },
        tts: { downloaded: ttsReady, sizeLabel: '~170 MB', name: 'Kokoro', purpose: 'TTS' },
      });
    } catch { /* ignore */ }
    setLoading(false);
  }

  const whisperReady = models.whisper?.downloaded;
  const isSetupMode = !whisperReady;

  if (loading) return null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10 pb-20">
        {/* Hero */}
        <div className="text-center mb-10">
          <img src={micIdleImg} alt="IronMic" className="w-28 h-28 mx-auto mb-4 object-contain" />
          <h1 className="text-2xl font-bold text-iron-text">
            {isSetupMode ? 'Welcome to IronMic' : 'IronMic'}
          </h1>
          <p className="text-sm text-iron-text-muted mt-2 max-w-md mx-auto leading-relaxed">
            {isSetupMode
              ? 'Speak freely. Transcribe locally. Everything runs on your machine — no cloud, no accounts, no data ever leaves your device.'
              : `Press ${hotkey} anywhere to dictate. Your voice, your words, your machine.`}
          </p>
        </div>

        {/* ── SETUP MODE ── */}
        {isSetupMode && (
          <div className="space-y-6">
            <Card variant="highlighted" padding="lg">
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-iron-accent/10 flex items-center justify-center flex-shrink-0">
                  <Download className="w-5 h-5 text-iron-accent-light" />
                </div>
                <div className="flex-1">
                  <p className="text-base font-semibold text-iron-text">Download the speech model to get started</p>
                  <p className="text-xs text-iron-text-muted mt-1.5 leading-relaxed">
                    IronMic needs the Whisper speech recognition model (~1.5 GB) to transcribe your voice.
                    It runs entirely on your machine — nothing is sent anywhere.
                  </p>
                  <button
                    onClick={() => onNavigate('settings')}
                    className="mt-3 px-4 py-2 text-xs font-medium bg-gradient-accent text-white rounded-lg hover:shadow-glow transition-all"
                  >
                    Go to Settings
                  </button>
                </div>
              </div>
            </Card>

            {/* Collapsed feature preview */}
            <details className="group">
              <summary className="text-xs font-medium text-iron-accent-light cursor-pointer hover:underline list-none flex items-center gap-1">
                What can IronMic do?
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <FeatureHint icon={Mic} label="Dictate" description="Voice to text anywhere" />
                <FeatureHint icon={Sparkles} label="AI Assistant" description="Chat with a local AI" />
                <FeatureHint icon={Volume2} label="Listen" description="Hear text read aloud" />
                <FeatureHint icon={Users} label="Meetings" description="Record and summarize" />
                <FeatureHint icon={StickyNote} label="Notes" description="Organize in notebooks" />
                <FeatureHint icon={Search} label="Search" description="Find anything, fast" />
              </div>
            </details>
          </div>
        )}

        {/* ── READY MODE ── */}
        {!isSetupMode && (
          <div className="space-y-8">
            {/* Quick actions grid — 3x2 */}
            <div>
              <h2 className="text-sm font-semibold text-iron-text-muted uppercase tracking-wider mb-3">Quick Start</h2>
              <div className="grid grid-cols-3 gap-3">
                <QuickAction icon={PenTool} title="Dictate" description={`${hotkey} anywhere`} onClick={() => onNavigate('dictate')} color="accent" />
                <QuickAction icon={Sparkles} title="AI Assistant" description="Chat with AI" onClick={() => onNavigate('ai')} color="purple" />
                <QuickAction icon={StickyNote} title="Notes" description="Notebooks & tags" onClick={() => onNavigate('notes')} color="amber" />
                <QuickAction icon={List} title="Timeline" description="Dictation history" onClick={() => onNavigate('main')} color="accent" />
                <QuickAction icon={Search} title="Search" description="Find anything" onClick={() => onNavigate('search')} color="accent" />
                <QuickAction icon={Users} title="Meetings" description="Record & summarize" onClick={() => onNavigate('meetings')} color="blue" />
              </div>
            </div>

            {/* Compact model status bar */}
            <div className="flex items-center justify-between px-4 py-3 bg-iron-surface rounded-xl border border-iron-border">
              <div className="flex items-center gap-4">
                {Object.entries(models).map(([key, m]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    {m.downloaded
                      ? <span className="w-1.5 h-1.5 rounded-full bg-iron-success" />
                      : <span className="w-1.5 h-1.5 rounded-full bg-iron-text-muted/30" />}
                    <span className={`text-[11px] ${m.downloaded ? 'text-iron-text-secondary' : 'text-iron-text-muted'}`}>
                      {m.purpose}
                    </span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => onNavigate('settings')}
                className="text-[11px] text-iron-accent-light hover:underline"
              >
                Manage
              </button>
            </div>

            {/* Security badge — only first 3 visits */}
            {visitCount <= 3 && (
              <Card variant="default" padding="md">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-iron-success/10 flex items-center justify-center flex-shrink-0">
                    <Shield className="w-4.5 h-4.5 text-iron-success" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-iron-text">100% Local & Private</p>
                    <p className="text-xs text-iron-text-muted mt-0.5">
                      All processing happens on your machine. No network calls, no telemetry, no accounts.
                    </p>
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, title, description, onClick, color }: {
  icon: typeof Mic; title: string; description: string; onClick: () => void; color: string;
}) {
  const colorMap: Record<string, string> = {
    accent: 'bg-iron-accent/10 text-iron-accent-light',
    purple: 'bg-purple-500/10 text-purple-400',
    emerald: 'bg-emerald-500/10 text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-400',
    blue: 'bg-blue-500/10 text-blue-400',
  };
  return (
    <button onClick={onClick} className="text-left p-3.5 rounded-xl border border-iron-border hover:border-iron-border-hover hover:bg-iron-surface-hover transition-all">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${colorMap[color] || colorMap.accent}`}>
        <Icon className="w-4 h-4" />
      </div>
      <p className="text-sm font-medium text-iron-text">{title}</p>
      <p className="text-[10px] text-iron-text-muted mt-0.5">{description}</p>
    </button>
  );
}

function FeatureHint({ icon: Icon, label, description }: { icon: typeof Mic; label: string; description: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-iron-surface/50">
      <Icon className="w-3.5 h-3.5 text-iron-text-muted flex-shrink-0" />
      <div>
        <p className="text-xs font-medium text-iron-text">{label}</p>
        <p className="text-[10px] text-iron-text-muted">{description}</p>
      </div>
    </div>
  );
}

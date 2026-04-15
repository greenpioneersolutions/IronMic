import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import {
  BarChart3, Clock, Flame, TrendingUp, TrendingDown, Minus,
  BookOpen, Zap, Loader2, Brain, AlertTriangle, RefreshCw,
  Users, MessageSquare, Mic, Share2, FileText,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Card, PageHeader } from './ui';
import { useAnalyticsStore } from '../stores/useAnalyticsStore';
import type { AnalyticsPeriod } from '../types';

const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  all_time: 'All Time',
};

const TOPIC_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Error boundary to catch Recharts or data rendering crashes
class AnalyticsErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) { console.error('[AnalyticsPage] Render error:', error); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
          <AlertTriangle className="w-10 h-10 text-yellow-500" />
          <h2 className="text-lg font-semibold text-iron-text">Analytics couldn't load</h2>
          <p className="text-sm text-iron-text-muted text-center max-w-md">
            This usually happens on a fresh install before any dictation data exists.
            Try recording a dictation first, then come back.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-iron-accent/10 text-iron-accent-light rounded-lg hover:bg-iron-accent/20 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function AnalyticsPage() {
  return (
    <AnalyticsErrorBoundary>
      <AnalyticsPageInner />
    </AnalyticsErrorBoundary>
  );
}

function AnalyticsPageInner() {
  const {
    overview, dailyTrend, topWords, sourceBreakdown, topicBreakdown,
    topicTrends, streaks, productivity, vocabularyRichness,
    period, loading, topicClassificationRunning, unclassifiedCount,
    setPeriod, loadAll, runTopicClassification, ensureBackfill,
  } = useAnalyticsStore();

  useEffect(() => {
    ensureBackfill().then(() => loadAll());
  }, []);

  const handlePeriodChange = useCallback((p: AnalyticsPeriod) => {
    setPeriod(p);
  }, [setPeriod]);

  return (
    <div className="h-full overflow-y-auto flex flex-col">
      <PageHeader icon={BarChart3} title="Analytics" description="Track your dictation habits and productivity" actions={
        <PeriodSelector period={period} onChange={handlePeriodChange} />
      } />
      <div className="flex-1 p-6 space-y-6">
      {loading && !overview ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-iron-accent-light" />
          <span className="ml-2 text-sm text-iron-text-muted">Computing analytics...</span>
        </div>
      ) : (
        <>
          {/* Overview stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Words"
              value={formatNumber(overview?.total_words ?? 0)}
              icon={<BookOpen className="w-4 h-4" />}
            />
            <StatCard
              label="Recording Time"
              value={formatDuration(overview?.total_duration_seconds ?? 0)}
              icon={<Clock className="w-4 h-4" />}
            />
            <StatCard
              label="Words / Min"
              value={Math.round(overview?.avg_words_per_minute ?? 0).toString()}
              icon={<Zap className="w-4 h-4" />}
            />
            <StatCard
              label="Daily Streak"
              value={`${streaks?.current_streak ?? 0} days`}
              subtitle={`Longest: ${streaks?.longest_streak ?? 0}`}
              icon={<Flame className="w-4 h-4" />}
            />
          </div>

          {/* Productivity comparison banner */}
          {productivity && (productivity.this_period_words > 0 || productivity.prev_period_words > 0) && (
            <ProductivityBanner productivity={productivity} />
          )}

          {/* Word trend chart */}
          {dailyTrend.length > 0 && (
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Words Per Day</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={dailyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--iron-border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--iron-text-muted)' }}
                    tickFormatter={(d) => d.slice(5)}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--iron-text-muted)' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--iron-surface)',
                      border: '1px solid var(--iron-border)',
                      borderRadius: '8px',
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="word_count"
                    stroke="var(--iron-accent)"
                    fill="var(--iron-accent)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    name="Words"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          )}

          {/* Two column: top words + vocabulary */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top Words */}
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Top Words</h3>
              {topWords.length > 0 ? (
                <div className="space-y-2">
                  {topWords.slice(0, 12).map(([word, count], i) => {
                    const maxCount = topWords[0]?.[1] ?? 1;
                    const pct = (count / maxCount) * 100;
                    return (
                      <div key={word} className="flex items-center gap-2">
                        <span className="text-xs text-iron-text-muted w-5 text-right">{i + 1}</span>
                        <span className="text-xs text-iron-text w-24 truncate">{word}</span>
                        <div className="flex-1 h-4 bg-iron-surface-hover rounded-full overflow-hidden">
                          <div
                            className="h-full bg-iron-accent/30 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-iron-text-muted w-10 text-right">{count}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-iron-text-muted">No data yet. Start dictating to see your top words.</p>
              )}
            </Card>

            {/* Vocabulary Richness */}
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Vocabulary</h3>
              {vocabularyRichness ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-iron-text">
                        {formatNumber(vocabularyRichness.unique_count)}
                      </p>
                      <p className="text-xs text-iron-text-muted mt-1">Unique Words</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-iron-text">
                        {formatNumber(vocabularyRichness.total_count)}
                      </p>
                      <p className="text-xs text-iron-text-muted mt-1">Total Words</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-iron-accent-light">
                        {(vocabularyRichness.ttr * 100).toFixed(1)}%
                      </p>
                      <p className="text-xs text-iron-text-muted mt-1">Vocab Richness</p>
                    </div>
                  </div>
                  <p className="text-xs text-iron-text-muted">
                    Vocabulary richness (type-token ratio) measures how diverse your word usage is.
                    Higher means more varied vocabulary.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-iron-text-muted">No data yet.</p>
              )}
            </Card>
          </div>

          {/* Two column: topics + topic trends */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Topic breakdown */}
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-iron-text">Topics</h3>
                <div className="flex items-center gap-2">
                  {unclassifiedCount > 0 && (
                    <span className="text-[10px] text-iron-text-muted">
                      {unclassifiedCount} unanalyzed
                    </span>
                  )}
                  <button
                    onClick={runTopicClassification}
                    disabled={topicClassificationRunning || unclassifiedCount === 0}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-iron-accent/10 text-iron-accent-light hover:bg-iron-accent/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {topicClassificationRunning ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Brain className="w-3 h-3" />
                    )}
                    Analyze
                  </button>
                </div>
              </div>
              {topicBreakdown.length > 0 ? (
                <div className="flex gap-4">
                  <div className="w-32 h-32 flex-shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={topicBreakdown}
                          dataKey="entry_count"
                          nameKey="topic"
                          cx="50%"
                          cy="50%"
                          innerRadius={25}
                          outerRadius={50}
                          strokeWidth={1}
                          stroke="var(--iron-bg)"
                        >
                          {topicBreakdown.map((_, i) => (
                            <Cell key={i} fill={TOPIC_COLORS[i % TOPIC_COLORS.length]} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 space-y-1.5 overflow-y-auto max-h-32">
                    {topicBreakdown.map((topic, i) => (
                      <div key={topic.topic} className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: TOPIC_COLORS[i % TOPIC_COLORS.length] }}
                        />
                        <span className="text-xs text-iron-text truncate flex-1">{topic.topic}</span>
                        <span className="text-xs text-iron-text-muted">{Math.round(topic.percentage)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <Brain className="w-8 h-8 text-iron-text-muted mx-auto mb-2" />
                  <p className="text-xs text-iron-text-muted">
                    {unclassifiedCount > 0
                      ? 'Click "Analyze" to classify your dictations into topics using the local LLM.'
                      : 'No entries to analyze yet.'}
                  </p>
                </div>
              )}
            </Card>

            {/* Topic trends */}
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Topic Trends</h3>
              {topicTrends.length > 0 ? (
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={aggregateTopicTrends(topicTrends)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--iron-border)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: 'var(--iron-text-muted)' }}
                      tickFormatter={(d) => d.slice(5)}
                    />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--iron-text-muted)' }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--iron-surface)',
                        border: '1px solid var(--iron-border)',
                        borderRadius: '8px',
                        fontSize: 11,
                      }}
                    />
                    {getUniqueTopics(topicTrends).slice(0, 5).map((topic, i) => (
                      <Bar
                        key={topic}
                        dataKey={topic}
                        stackId="topics"
                        fill={TOPIC_COLORS[i % TOPIC_COLORS.length]}
                        name={topic}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-xs text-iron-text-muted py-6 text-center">
                  Topic trends will appear after entries are analyzed.
                </p>
              )}
            </Card>
          </div>

          {/* Two column: source apps + session stats */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Source App Breakdown */}
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Source Apps</h3>
              {Object.keys(sourceBreakdown).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(sourceBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([app, count]) => {
                      const maxCount = Math.max(...Object.values(sourceBreakdown));
                      const pct = (count / maxCount) * 100;
                      const label = app.startsWith('ai-chat') ? 'AI Chat' : app;
                      return (
                        <div key={app} className="flex items-center gap-2">
                          <span className="text-xs text-iron-text w-20 truncate">{label}</span>
                          <div className="flex-1 h-4 bg-iron-surface-hover rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500/30 rounded-full"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-iron-text-muted w-8 text-right">{count}</span>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <p className="text-xs text-iron-text-muted">No source app data yet.</p>
              )}
            </Card>

            {/* Session Stats */}
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-iron-text mb-4">Session Stats</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold text-iron-text">
                    {overview?.total_entries ?? 0}
                  </p>
                  <p className="text-xs text-iron-text-muted mt-1">Total Dictations</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-iron-text">
                    {overview && overview.total_entries > 0
                      ? formatDuration(overview.total_duration_seconds / overview.total_entries)
                      : '0s'}
                  </p>
                  <p className="text-xs text-iron-text-muted mt-1">Avg Length</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-iron-text">
                    {overview?.total_sentences ?? 0}
                  </p>
                  <p className="text-xs text-iron-text-muted mt-1">Total Sentences</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-iron-text">
                    {Math.round(overview?.avg_sentence_length ?? 0)}
                  </p>
                  <p className="text-xs text-iron-text-muted mt-1">Avg Words/Sentence</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Cross-tool activity */}
          <ActivityOverview />
        </>
      )}
      </div>
    </div>
  );
}

/** Shows stats from meetings, AI chat, and all content across the app. */
function ActivityOverview() {
  const [meetingCount, setMeetingCount] = useState(0);
  const [meetingMinutes, setMeetingMinutes] = useState(0);
  const [aiChatCount, setAiChatCount] = useState(0);
  const [aiEntryWords, setAiEntryWords] = useState(0);
  const [dictationEntries, setDictationEntries] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const [recentActivity, setRecentActivity] = useState<Array<{ type: string; label: string; time: string }>>([]);

  useEffect(() => {
    loadActivityStats();
  }, []);

  async function loadActivityStats() {
    const api = window.ironmic;
    try {
      // Meeting stats
      const meetingsJson = await api.meetingList(100, 0).catch(() => '[]');
      const meetings = JSON.parse(meetingsJson);
      setMeetingCount(meetings.length);
      const totalMeetingSeconds = meetings.reduce((sum: number, m: any) => sum + (m.total_duration_seconds || 0), 0);
      setMeetingMinutes(Math.round(totalMeetingSeconds / 60));

      // Entry stats — count AI vs dictation
      const entriesJson = await api.listEntries({ limit: 1000, offset: 0 }).catch(() => '[]');
      const entries = Array.isArray(entriesJson) ? entriesJson : JSON.parse(entriesJson);
      setTotalEntries(entries.length);
      const aiEntries = entries.filter((e: any) => e.sourceApp?.startsWith('ai-chat') || e.source_app?.startsWith('ai-chat'));
      const dictEntries = entries.filter((e: any) => !e.sourceApp?.startsWith('ai-chat') && !e.source_app?.startsWith('ai-chat'));
      setAiChatCount(aiEntries.length);
      setDictationEntries(dictEntries.length);

      // Word count from AI entries
      const aiWords = aiEntries.reduce((sum: number, e: any) => {
        const text = e.polishedText || e.polished_text || e.rawTranscript || e.raw_transcript || '';
        return sum + text.split(/\s+/).filter(Boolean).length;
      }, 0);
      setAiEntryWords(aiWords);

      // Recent activity timeline (last 10 items across all types)
      const activity: Array<{ type: string; label: string; time: string; sortTime: number }> = [];

      // Add dictation entries
      for (const e of dictEntries.slice(0, 5)) {
        const text = e.polishedText || e.polished_text || e.rawTranscript || e.raw_transcript || '';
        activity.push({
          type: 'dictation',
          label: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
          time: e.createdAt || e.created_at,
          sortTime: new Date(e.createdAt || e.created_at).getTime(),
        });
      }

      // Add AI entries
      for (const e of aiEntries.slice(0, 5)) {
        const text = e.polishedText || e.polished_text || e.rawTranscript || e.raw_transcript || '';
        activity.push({
          type: 'ai',
          label: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
          time: e.createdAt || e.created_at,
          sortTime: new Date(e.createdAt || e.created_at).getTime(),
        });
      }

      // Add meetings
      for (const m of meetings.slice(0, 5)) {
        const dur = m.total_duration_seconds ? `${Math.round(m.total_duration_seconds / 60)}min` : '';
        activity.push({
          type: 'meeting',
          label: `Meeting${m.detected_app ? ` (${m.detected_app})` : ''} ${dur}`.trim(),
          time: m.started_at,
          sortTime: new Date(m.started_at).getTime(),
        });
      }

      // Sort by time, most recent first
      activity.sort((a, b) => b.sortTime - a.sortTime);
      setRecentActivity(activity.slice(0, 10));
    } catch (err) {
      console.error('[ActivityOverview] Failed to load:', err);
    }
  }

  const activityIcon = (type: string) => {
    switch (type) {
      case 'dictation': return <Mic className="w-3 h-3 text-iron-accent-light" />;
      case 'ai': return <MessageSquare className="w-3 h-3 text-purple-400" />;
      case 'meeting': return <Users className="w-3 h-3 text-green-400" />;
      default: return <FileText className="w-3 h-3 text-iron-text-muted" />;
    }
  };

  return (
    <>
      {/* Cross-tool stat cards */}
      <div className="flex items-center gap-2 mt-2">
        <Share2 className="w-4 h-4 text-iron-text-muted" />
        <h3 className="text-sm font-semibold text-iron-text">All Activity</h3>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Dictations"
          value={dictationEntries.toString()}
          icon={<Mic className="w-4 h-4" />}
        />
        <StatCard
          label="AI Conversations"
          value={aiChatCount.toString()}
          subtitle={aiEntryWords > 0 ? `${formatNumber(aiEntryWords)} words` : undefined}
          icon={<MessageSquare className="w-4 h-4" />}
        />
        <StatCard
          label="Meetings"
          value={meetingCount.toString()}
          subtitle={meetingMinutes > 0 ? `${meetingMinutes} min total` : undefined}
          icon={<Users className="w-4 h-4" />}
        />
        <StatCard
          label="Total Entries"
          value={totalEntries.toString()}
          icon={<BookOpen className="w-4 h-4" />}
        />
      </div>

      {/* Recent activity feed */}
      {recentActivity.length > 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-iron-text mb-3">Recent Activity</h3>
          <div className="space-y-2">
            {recentActivity.map((item, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <div className="mt-0.5">{activityIcon(item.type)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-iron-text truncate">{item.label}</p>
                  <p className="text-[10px] text-iron-text-muted">
                    {new Date(item.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    <span className={
                      item.type === 'dictation' ? 'text-iron-accent-light' :
                      item.type === 'ai' ? 'text-purple-400' :
                      'text-green-400'
                    }>
                      {item.type === 'dictation' ? 'Dictation' : item.type === 'ai' ? 'AI Chat' : 'Meeting'}
                    </span>
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

// ── Sub-components ──

function PeriodSelector({ period, onChange }: { period: AnalyticsPeriod; onChange: (p: AnalyticsPeriod) => void }) {
  const periods: AnalyticsPeriod[] = ['today', 'week', 'month', 'all_time'];
  return (
    <div className="flex gap-1 bg-iron-surface rounded-lg p-1 border border-iron-border">
      {periods.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            period === p
              ? 'bg-iron-accent/15 text-iron-accent-light'
              : 'text-iron-text-muted hover:text-iron-text-secondary'
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

function StatCard({ label, value, subtitle, icon }: {
  label: string; value: string; subtitle?: string; icon: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-iron-text-muted mb-2">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xl font-bold text-iron-text">{value}</p>
      {subtitle && <p className="text-[10px] text-iron-text-muted mt-0.5">{subtitle}</p>}
    </Card>
  );
}

function ProductivityBanner({ productivity }: { productivity: { this_period_words: number; prev_period_words: number; change_percent: number; period_label: string } }) {
  const isUp = productivity.change_percent > 0;
  const isFlat = productivity.change_percent === 0;
  const absPercent = Math.abs(Math.round(productivity.change_percent));

  return (
    <Card className={`p-4 flex items-center gap-3 ${
      isUp ? 'bg-emerald-500/5 border-emerald-500/20' :
      isFlat ? 'bg-iron-surface' :
      'bg-amber-500/5 border-amber-500/20'
    }`}>
      {isUp ? (
        <TrendingUp className="w-5 h-5 text-emerald-400 flex-shrink-0" />
      ) : isFlat ? (
        <Minus className="w-5 h-5 text-iron-text-muted flex-shrink-0" />
      ) : (
        <TrendingDown className="w-5 h-5 text-amber-400 flex-shrink-0" />
      )}
      <div>
        <p className="text-sm font-semibold text-iron-text">
          {isUp
            ? `${absPercent}% more words than last ${productivity.period_label}`
            : isFlat
            ? `Same output as last ${productivity.period_label}`
            : `${absPercent}% fewer words than last ${productivity.period_label}`}
        </p>
        <p className="text-xs text-iron-text-muted">
          {formatNumber(productivity.this_period_words)} this {productivity.period_label} vs {formatNumber(productivity.prev_period_words)} last {productivity.period_label}
        </p>
      </div>
    </Card>
  );
}

// ── Helpers for topic trend charts ──

function getUniqueTopics(trends: { topic: string }[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of trends) {
    if (!seen.has(t.topic)) {
      seen.add(t.topic);
      result.push(t.topic);
    }
  }
  return result;
}

function aggregateTopicTrends(trends: { date: string; topic: string; count: number }[]): Record<string, any>[] {
  const byDate = new Map<string, Record<string, any>>();
  for (const t of trends) {
    if (!byDate.has(t.date)) {
      byDate.set(t.date, { date: t.date });
    }
    byDate.get(t.date)![t.topic] = (byDate.get(t.date)![t.topic] ?? 0) + t.count;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

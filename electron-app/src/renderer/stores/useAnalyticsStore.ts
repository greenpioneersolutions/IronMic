import { create } from 'zustand';
import type {
  AnalyticsPeriod,
  OverviewStats,
  DailySnapshot,
  TopicStat,
  TopicTrend,
  StreakInfo,
  ProductivityComparison,
  VocabularyRichness,
} from '../types';

interface AnalyticsStore {
  // Data
  overview: OverviewStats | null;
  dailyTrend: DailySnapshot[];
  topWords: [string, number][];
  sourceBreakdown: Record<string, number>;
  topicBreakdown: TopicStat[];
  topicTrends: TopicTrend[];
  streaks: StreakInfo | null;
  productivity: ProductivityComparison | null;
  vocabularyRichness: VocabularyRichness | null;

  // UI state
  period: AnalyticsPeriod;
  loading: boolean;
  topicClassificationRunning: boolean;
  unclassifiedCount: number;
  backfillDone: boolean;

  // Actions
  setPeriod: (period: AnalyticsPeriod) => void;
  loadAll: () => Promise<void>;
  runTopicClassification: () => Promise<void>;
  ensureBackfill: () => Promise<void>;
}

function periodToRange(period: AnalyticsPeriod): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);

  let from: string;
  switch (period) {
    case 'today':
      from = to;
      break;
    case 'week': {
      const day = today.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday = 0
      const monday = new Date(today);
      monday.setDate(today.getDate() - diff);
      from = monday.toISOString().slice(0, 10);
      break;
    }
    case 'month':
      from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      break;
    default:
      from = '2020-01-01';
  }

  return { from, to };
}

export const useAnalyticsStore = create<AnalyticsStore>((set, get) => ({
  overview: null,
  dailyTrend: [],
  topWords: [],
  sourceBreakdown: {},
  topicBreakdown: [],
  topicTrends: [],
  streaks: null,
  productivity: null,
  vocabularyRichness: null,

  period: 'week',
  loading: false,
  topicClassificationRunning: false,
  unclassifiedCount: 0,
  backfillDone: false,

  setPeriod: (period) => {
    set({ period });
    get().loadAll();
  },

  loadAll: async () => {
    set({ loading: true });
    const { period } = get();
    const { from, to } = periodToRange(period);

    try {
      const api = (window as any).ironmic;
      const [
        overviewJson,
        trendJson,
        topWordsJson,
        sourceJson,
        richJson,
        streaksJson,
        productivityJson,
        topicBreakdownJson,
        topicTrendsJson,
        unclassifiedCount,
      ] = await Promise.all([
        api.analyticsGetOverview(period),
        api.analyticsGetDailyTrend(from, to),
        api.analyticsGetTopWords(from, to, 20),
        api.analyticsGetSourceBreakdown(from, to),
        api.analyticsGetVocabularyRichness(from, to),
        api.analyticsGetStreaks(),
        api.analyticsGetProductivityComparison(),
        api.analyticsGetTopicBreakdown(from, to),
        api.analyticsGetTopicTrends(from, to),
        api.analyticsGetUnclassifiedCount(),
      ]);

      set({
        overview: JSON.parse(overviewJson),
        dailyTrend: JSON.parse(trendJson),
        topWords: JSON.parse(topWordsJson),
        sourceBreakdown: JSON.parse(sourceJson),
        vocabularyRichness: JSON.parse(richJson),
        streaks: JSON.parse(streaksJson),
        productivity: JSON.parse(productivityJson),
        topicBreakdown: JSON.parse(topicBreakdownJson),
        topicTrends: JSON.parse(topicTrendsJson),
        unclassifiedCount,
        loading: false,
      });
    } catch (err) {
      console.error('[analytics] Failed to load analytics:', err);
      set({ loading: false });
    }
  },

  runTopicClassification: async () => {
    set({ topicClassificationRunning: true });
    try {
      const api = (window as any).ironmic;
      await api.analyticsClassifyTopicsBatch(10);
      // Reload topics after classification
      const { period } = get();
      const { from, to } = periodToRange(period);
      const [topicBreakdownJson, topicTrendsJson, unclassifiedCount] = await Promise.all([
        api.analyticsGetTopicBreakdown(from, to),
        api.analyticsGetTopicTrends(from, to),
        api.analyticsGetUnclassifiedCount(),
      ]);
      set({
        topicBreakdown: JSON.parse(topicBreakdownJson),
        topicTrends: JSON.parse(topicTrendsJson),
        unclassifiedCount,
        topicClassificationRunning: false,
      });
    } catch (err) {
      console.error('[analytics] Topic classification failed:', err);
      set({ topicClassificationRunning: false });
    }
  },

  ensureBackfill: async () => {
    if (get().backfillDone) return;
    try {
      const api = (window as any).ironmic;
      const done = await api.getSetting('analytics_backfill_done');
      if (done === 'true') {
        set({ backfillDone: true });
        return;
      }
      await api.analyticsBackfill();
      await api.setSetting('analytics_backfill_done', 'true');
      set({ backfillDone: true });
    } catch (err) {
      console.error('[analytics] Backfill failed:', err);
      set({ backfillDone: true }); // Don't block the UI
    }
  },
}));

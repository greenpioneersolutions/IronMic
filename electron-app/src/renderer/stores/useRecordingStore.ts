import { create } from 'zustand';
import { useTtsStore } from './useTtsStore';
import { useEntryStore } from './useEntryStore';
import { useAiChatStore } from './useAiChatStore';
import { useToastStore } from './useToastStore';
import { vadService } from '../services/tfjs/VADService';
import { audioBridge } from '../services/tfjs/AudioBridge';
import type { PipelineState, TranscriptionResult, VoiceState } from '../types';

interface RecordingStore {
  state: PipelineState;
  lastResult: TranscriptionResult | null;
  error: string | null;
  /** Real-time voice state from VAD (speech/silence/unknown) */
  voiceState: VoiceState;
  /** Whether VAD is active for the current recording */
  vadActive: boolean;

  setState: (state: PipelineState) => void;
  setResult: (result: TranscriptionResult) => void;
  setError: (error: string | null) => void;
  reset: () => void;

  // Full recording flow. sourceApp tags the entry (e.g. 'ai-chat').
  handleHotkeyPress: (sourceApp?: string) => Promise<void>;
}

// Guard against double-invocations
let actionInProgress = false;

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  state: 'idle',
  lastResult: null,
  error: null,
  voiceState: 'unknown',
  vadActive: false,

  setState: (state) => set({ state }),
  setResult: (result) => set({ lastResult: result, state: 'idle' }),
  setError: (error) => set({ error }),
  reset: () => set({ state: 'idle', lastResult: null, error: null, voiceState: 'unknown', vadActive: false }),

  handleHotkeyPress: async (sourceApp?: string) => {
    // Prevent double-invocation (sidebar + page button + hotkey racing)
    if (actionInProgress) return;
    actionInProgress = true;

    try {
      await handleRecordingAction(get, set, sourceApp);
    } finally {
      actionInProgress = false;
    }
  },
}));

async function handleRecordingAction(
  get: () => RecordingStore,
  set: (partial: Partial<RecordingStore>) => void,
  sourceApp?: string,
) {
  const { state } = get();
  const api = window.ironmic;

  if (state === 'processing') return;

  // ── START RECORDING ──
  if (state === 'idle') {
    try {
      // Stop TTS playback before recording
      try { await useTtsStore.getState().stop(); } catch { /* ignore */ }
      set({ state: 'recording', error: null, voiceState: 'unknown', vadActive: false });

      // Start VAD alongside recording (non-blocking — VAD failure is not fatal)
      try {
        const vadEnabled = await api.getSetting('vad_enabled');
        if (vadEnabled !== 'false') {
          const sensitivity = parseFloat((await api.getSetting('vad_sensitivity')) || '0.5');
          vadService.setSensitivity(sensitivity);
          await vadService.start();
          set({ vadActive: true });
          // Subscribe to real-time voice state for UI indicator
          vadService.onVoiceStateChange((voiceState) => {
            set({ voiceState });
          });
        }
      } catch (vadErr) {
        console.warn('[recording] VAD failed to start (non-fatal):', vadErr);
      }

      // Start AudioBridge recording buffer (captures from user's selected mic)
      if (audioBridge.isActive()) {
        audioBridge.startRecording();
      }

      try {
        await api.startRecording();
      } catch (startErr: any) {
        // If Rust says "already active", the state is out of sync.
        // Force-reset Rust, then retry once.
        if (startErr.message?.includes('already active')) {
          console.warn('[recording] Rust says already active — force-resetting and retrying');
          try {
            await api.resetRecording();
            await api.startRecording();
          } catch (retryErr: any) {
            set({ state: 'idle', error: retryErr.message || 'Failed to start recording' });
            showErrorToast('Recording failed to start. Please try again.', retryErr.message);
            return;
          }
        } else {
          throw startErr;
        }
      }
    } catch (err: any) {
      set({ state: 'idle', error: err.message || 'Failed to start recording' });
      showErrorToast('Could not access your microphone.', err.message);
    }
    return;
  }

  // ── STOP RECORDING + PROCESS ──
  if (state === 'recording') {
    const entryStore = useEntryStore.getState();

    try {
      set({ state: 'processing', voiceState: 'unknown' });

      // Show pending entry immediately in the timeline
      entryStore.setPendingEntry({
        stage: 'transcribing',
        startedAt: Date.now(),
      });

      // Stop VAD and check speech detection
      const vadResult = vadService.isActive() ? vadService.stop() : null;
      set({ vadActive: false });

      if (vadResult && !vadResult.hasSufficientSpeech) {
        console.warn(`[recording] VAD: insufficient speech (${vadResult.totalSpeechMs}ms) — proceeding anyway (Whisper will decide)`);
        window.dispatchEvent(new CustomEvent('ironmic:dictation-low-audio', {
          detail: { speechMs: vadResult.totalSpeechMs },
        }));
      }

      // Get audio from AudioBridge (user's selected mic) with cpal fallback
      let audioBuffer: Buffer;
      const bridgeResult = audioBridge.isRecording() ? audioBridge.stopRecording() : null;

      if (bridgeResult?.buffer && bridgeResult.durationSeconds > 0.5) {
        audioBuffer = bridgeResult.buffer;
        console.log(`[recording] Using AudioBridge audio (${bridgeResult.durationSeconds.toFixed(2)}s from selected mic)`);
        try { await api.stopRecording(); } catch { /* ignore */ }
      } else {
        console.warn('[recording] AudioBridge buffer empty/short, falling back to Rust cpal audio');
        try {
          audioBuffer = await api.stopRecording();
        } catch (stopErr: any) {
          console.error('[recording] Stop failed, force-resetting:', stopErr);
          try { await api.resetRecording(); } catch { /* last resort */ }
          entryStore.setPendingEntry(null);
          set({ state: 'idle', error: null });
          showErrorToast('Recording stopped unexpectedly.', 'The recording was reset. Please try again.');
          return;
        }
      }

      // ── STAGE 1: Transcription ──
      let rawTranscript: string;
      try {
        rawTranscript = await api.transcribe(audioBuffer);
      } catch (transcribeErr: any) {
        entryStore.setPendingEntry(null);
        set({ state: 'idle', error: transcribeErr.message });
        showErrorToast(
          'Transcription failed.',
          transcribeErr.message?.includes('not found') || transcribeErr.message?.includes('not downloaded')
            ? 'The Whisper model is not downloaded. Go to Settings > Models to download it.'
            : transcribeErr.message,
          transcribeErr.message?.includes('not found') || transcribeErr.message?.includes('not downloaded')
            ? { label: 'Go to Settings', onClick: () => window.dispatchEvent(new CustomEvent('ironmic:navigate', { detail: 'settings' })) }
            : undefined,
        );
        return;
      }

      // Filter Whisper hallucinations
      const HALLUCINATIONS = [
        'thank you', 'thanks for watching', 'thanks for listening',
        'subscribe', 'like and subscribe', 'see you next time',
        'bye', 'goodbye', 'you', 'the end',
        'thanks', 'thank you for watching',
      ];
      const cleaned = rawTranscript.trim().toLowerCase().replace(/[.!?,]/g, '');
      const isHallucination = HALLUCINATIONS.includes(cleaned);

      if (!rawTranscript.trim() || rawTranscript.trim().startsWith('[stub') || isHallucination) {
        if (isHallucination) {
          console.warn(`[recording] Filtered Whisper hallucination: "${rawTranscript.trim()}"`);
        }
        entryStore.setPendingEntry(null);
        set({ state: 'idle', lastResult: null, error: null });
        window.dispatchEvent(new CustomEvent('ironmic:dictation-empty', {
          detail: isHallucination ? { reason: 'hallucination', text: rawTranscript.trim() } : undefined,
        }));
        return;
      }

      // Transcription done — show it immediately in the pending card
      entryStore.updatePendingEntry({
        stage: 'complete',
        rawTranscript,
      });

      // Build sourceApp
      if (sourceApp === 'ai-chat') {
        if (!useAiChatStore.getState().activeSessionId) {
          useAiChatStore.getState().createSession(null);
        }
        window.dispatchEvent(new CustomEvent('ironmic:ai-dictation', { detail: rawTranscript }));
      }
      let resolvedSourceApp = sourceApp;
      if (sourceApp === 'ai-chat') {
        const sessionId = useAiChatStore.getState().activeSessionId;
        if (sessionId) resolvedSourceApp = `ai-chat:${sessionId}`;
      }

      // Save entry to DB with raw transcript only (no auto-polish)
      let savedEntryId: string | null = null;
      try {
        const saved = await api.createEntry({
          rawTranscript,
          polishedText: undefined,
          durationSeconds: undefined,
          sourceApp: resolvedSourceApp ?? undefined,
        } as any);
        savedEntryId = saved?.id ?? null;
        entryStore.updatePendingEntry({ entryId: savedEntryId ?? undefined });
      } catch (saveErr: any) {
        console.error('[recording] Failed to save entry:', saveErr);
      }

      // Copy raw transcript to clipboard
      try {
        await api.copyToClipboard(rawTranscript);
        const autoClear = await api.getSetting('security_clipboard_auto_clear');
        if (autoClear && autoClear !== 'off') {
          const seconds = parseInt(autoClear);
          if (seconds > 0) {
            setTimeout(() => api.copyToClipboard('').catch(() => {}), seconds * 1000);
          }
        }
      } catch { /* clipboard is nice-to-have */ }

      // Auto read-back if enabled
      try {
        const autoReadback = await api.getSetting('tts_auto_readback');
        if (autoReadback === 'true' && rawTranscript.trim()) {
          await useTtsStore.getState().synthesizeAndPlay(rawTranscript);
        }
      } catch { /* TTS is optional */ }

      // Notify the app that dictation completed — includes sourceApp for page routing
      window.dispatchEvent(new CustomEvent('ironmic:dictation-complete', {
        detail: {
          text: rawTranscript,
          sourceApp: resolvedSourceApp || null,
          entryId: savedEntryId,
          preview: rawTranscript.length > 80 ? rawTranscript.slice(0, 80) + '...' : rawTranscript,
        },
      }));

      set({
        state: 'idle',
        lastResult: { rawTranscript, polishedText: null, durationSeconds: 0 },
        error: null,
      });

      // Keep the pending card visible briefly, then clear and refresh timeline
      setTimeout(() => {
        useEntryStore.getState().setPendingEntry(null);
        useEntryStore.getState().refresh();
      }, 2000);
    } catch (err: any) {
      // Catch-all: force-reset Rust side to ensure we're not stuck
      try { await api.resetRecording(); } catch { /* ignore */ }
      entryStore.setPendingEntry(null);
      set({ state: 'idle', error: err.message || 'Processing failed' });
      showErrorToast('Something went wrong during processing.', err.message);
    }
  }
}

/** Show an error toast with optional action button */
function showErrorToast(
  message: string,
  detail?: string,
  action?: { label: string; onClick: () => void },
) {
  useToastStore.getState().show({
    message: detail ? `${message} ${detail}` : message,
    type: 'error',
    durationMs: 10000,
    action,
  });
}

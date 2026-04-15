/**
 * MeetingDetector — Ambient Meeting Mode.
 *
 * Provides passive listening during meetings with:
 * - Energy-based speaker turn detection (not full diarization)
 * - Automatic meeting end detection (sustained silence after multi-voice input)
 * - Summary generation via local LLM on meeting end
 *
 * Uses the existing always-listening pipeline from TurnDetector
 * and VADService for voice activity tracking.
 */

import { vadService, type VoiceState } from './VADService';
import { audioBridge } from './AudioBridge';
import { generateStructuredNotes, structuredToMarkdown, type MeetingTemplate, type StructuredMeetingOutput } from './MeetingTemplateEngine';

export type MeetingState = 'idle' | 'listening' | 'processing' | 'ended';

export interface MeetingSegment {
  speakerLabel: string;
  startMs: number;
  endMs: number;
  transcript?: string;
}

export interface MeetingResult {
  sessionId: string;
  segments: MeetingSegment[];
  speakerCount: number;
  totalDurationMs: number;
  summary?: string;
  actionItems?: string[];
  structuredOutput?: StructuredMeetingOutput;
}

type MeetingStateCallback = (state: MeetingState) => void;

// Constants for meeting detection
const MEETING_END_SILENCE_MS = 30000; // 30s silence = meeting over

const DEFAULT_MEETING_PROMPT = 'Summarize this meeting transcript. List key decisions and action items.';

/** Get the user's custom meeting summary prompt, or the default. */
async function getMeetingSummaryPrompt(): Promise<string> {
  try {
    const custom = await (window as any).ironmic?.getSetting?.('meeting_summary_prompt');
    if (custom && custom.trim()) return custom.trim();
  } catch { /* setting not available */ }
  return DEFAULT_MEETING_PROMPT;
}

/** Check if a polishText result is a stub passthrough (contains the prompt). */
function isStubResult(result: string, prompt: string): boolean {
  // If the result starts with the prompt text, the LLM is a passthrough stub
  return result.startsWith(prompt.slice(0, 30));
}
const MIN_MEETING_DURATION_MS = 60000; // Minimum 1 min to count as a meeting
const ENERGY_WINDOW_MS = 2000; // Window for speaker energy analysis

export class MeetingDetector {
  private state: MeetingState = 'idle';
  private sessionId: string | null = null;
  private segments: MeetingSegment[] = [];
  private stateCallbacks: MeetingStateCallback[] = [];
  private startTime = 0;
  private lastSpeechTime = 0;
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private unsubVAD: (() => void) | null = null;

  // Speaker tracking (energy-based, approximate)
  private currentSpeakerEnergy = 0;
  private speakerEnergyHistory: number[] = [];
  private estimatedSpeakerCount = 1;
  private currentSegmentStart = 0;
  private template: MeetingTemplate | null = null;
  private detectedApp: string | null = null;

  getState(): MeetingState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Start ambient meeting mode.
   * @param template Optional meeting template for structured output
   * @param detectedApp Optional app name (zoom, teams, meet) if auto-detected
   */
  async start(template?: MeetingTemplate, detectedApp?: string): Promise<string> {
    if (this.state !== 'idle') {
      throw new Error('Meeting already in progress');
    }

    this.template = template || null;
    this.detectedApp = detectedApp || null;

    // Create meeting session in storage (with template if provided)
    const ironmic = (window as any).ironmic;
    let sessionId = 'meeting-' + Date.now();
    try {
      if (template && ironmic?.meetingCreateWithTemplate) {
        const result = await ironmic.meetingCreateWithTemplate(template.id, detectedApp || null);
        const parsed = JSON.parse(result);
        sessionId = parsed.id;
      } else if (ironmic?.meetingCreate) {
        const result = await ironmic.meetingCreate();
        const parsed = JSON.parse(result);
        sessionId = parsed.id;
      }
    } catch (err) {
      console.warn('[MeetingDetector] Failed to create session in storage:', err);
    }

    this.sessionId = sessionId;
    this.segments = [];
    this.startTime = Date.now();
    this.lastSpeechTime = Date.now();
    this.speakerEnergyHistory = [];
    this.estimatedSpeakerCount = 1;
    this.currentSegmentStart = 0;

    // Start audio capture via AudioBridge (uses user's selected mic)
    try {
      if (!audioBridge.isActive()) {
        await audioBridge.startStream();
      }
      audioBridge.startRecording();
    } catch (err) {
      console.warn('[MeetingDetector] Failed to start audio capture:', err);
    }

    // Subscribe to VAD for speech/silence tracking
    this.unsubVAD = vadService.onVoiceStateChange((voiceState: VoiceState) => {
      this.handleVoiceState(voiceState);
    });

    // Periodically check for meeting end
    this.silenceCheckInterval = setInterval(() => {
      this.checkMeetingEnd();
    }, 5000);

    this.setState('listening');
    console.log(`[MeetingDetector] Meeting started (session: ${sessionId})`);
    return sessionId;
  }

  /**
   * Manually stop the meeting.
   */
  async stop(): Promise<MeetingResult> {
    return this.endMeeting();
  }

  /**
   * Add a transcribed segment from the recording pipeline.
   */
  addSegment(transcript: string, durationMs: number): void {
    if (this.state !== 'listening') return;

    const now = Date.now();
    const segment: MeetingSegment = {
      speakerLabel: `Speaker ${this.estimatedSpeakerCount > 1 ? (this.segments.length % this.estimatedSpeakerCount) + 1 : 1}`,
      startMs: now - this.startTime - durationMs,
      endMs: now - this.startTime,
      transcript,
    };

    this.segments.push(segment);
  }

  /**
   * Register a callback for meeting state changes.
   */
  onStateChange(callback: MeetingStateCallback): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      this.stateCallbacks = this.stateCallbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Get the current meeting duration in milliseconds.
   */
  getDurationMs(): number {
    if (this.state === 'idle') return 0;
    return Date.now() - this.startTime;
  }

  /**
   * Get the estimated speaker count.
   */
  getSpeakerCount(): number {
    return this.estimatedSpeakerCount;
  }

  // ── Internal ──

  private handleVoiceState(state: VoiceState): void {
    if (state === 'speech') {
      this.lastSpeechTime = Date.now();
    }
  }

  private checkMeetingEnd(): void {
    if (this.state !== 'listening') return;

    const silenceDuration = Date.now() - this.lastSpeechTime;
    const meetingDuration = Date.now() - this.startTime;

    // Auto-end if sustained silence after minimum meeting duration
    if (silenceDuration >= MEETING_END_SILENCE_MS && meetingDuration >= MIN_MEETING_DURATION_MS) {
      console.log(`[MeetingDetector] Auto-ending meeting (silence: ${silenceDuration}ms)`);
      this.endMeeting();
    }
  }

  private async endMeeting(): Promise<MeetingResult> {
    this.setState('processing');

    // Cleanup
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
      this.silenceCheckInterval = null;
    }
    if (this.unsubVAD) {
      this.unsubVAD();
      this.unsubVAD = null;
    }

    const totalDurationMs = Date.now() - this.startTime;

    // Get recorded audio from AudioBridge and transcribe it
    const bridgeResult = audioBridge.isRecording() ? audioBridge.stopRecording() : null;
    let fullTranscript = '';

    if (bridgeResult?.buffer && bridgeResult.durationSeconds > 0.5) {
      try {
        const ironmic = (window as any).ironmic;
        if (ironmic?.transcribe) {
          console.log(`[MeetingDetector] Transcribing ${bridgeResult.durationSeconds.toFixed(1)}s of meeting audio...`);
          fullTranscript = await ironmic.transcribe(bridgeResult.buffer);
          console.log(`[MeetingDetector] Transcription: ${fullTranscript.length} chars`);
          // Add as a single segment
          this.segments.push({
            speakerLabel: 'Speaker 1',
            startMs: 0,
            endMs: totalDurationMs,
            transcript: fullTranscript,
          });
        }
      } catch (err) {
        console.warn('[MeetingDetector] Transcription failed:', err);
      }
    } else {
      // Fall back to any segments added externally
      fullTranscript = this.segments
        .map((s) => `${s.speakerLabel}: ${s.transcript || ''}`)
        .join('\n');
    }

    let summary: string | undefined;
    let actionItems: string[] | undefined;
    let structuredOutput: StructuredMeetingOutput | undefined;

    // Save raw transcript and end meeting FIRST — don't block on LLM
    const ironmic = (window as any).ironmic;
    if (ironmic?.meetingEnd && this.sessionId) {
      try {
        await ironmic.meetingEnd(
          this.sessionId,
          this.estimatedSpeakerCount,
          undefined, // summary — will be added later if LLM works
          undefined,
          totalDurationMs / 1000,
          undefined,
        );
        if (fullTranscript && ironmic?.meetingSetRawTranscript) {
          await ironmic.meetingSetRawTranscript(this.sessionId, fullTranscript);
        }
      } catch (err) {
        console.warn('[MeetingDetector] Failed to save meeting:', err);
      }
    }

    // Now try LLM summarization with a timeout — don't block the UI
    if (fullTranscript.length > 20) {
      const LLM_TIMEOUT_MS = 30000; // 30s max wait for LLM

      const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
        Promise.race([promise, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);

      try {
        if (this.template) {
          const templateResult = await withTimeout(generateStructuredNotes(this.template, fullTranscript), LLM_TIMEOUT_MS);
          if (templateResult) {
            structuredOutput = templateResult;
            summary = structuredToMarkdown(structuredOutput);
            const actionSection = structuredOutput.sections.find(s => s.key === 'action_items' || s.key === 'next_steps');
            if (actionSection && actionSection.content !== 'None mentioned') {
              actionItems = actionSection.content
                .split('\n')
                .map((l: string) => l.replace(/^[-*•]\s*/, '').trim())
                .filter((l: string) => l.length > 0);
            }
          } else {
            console.warn('[MeetingDetector] Template LLM timed out — use "Summarize Now" later');
          }
        } else {
          let llmWorked = false;
          const promptText = await getMeetingSummaryPrompt();

          if (ironmic?.polishText) {
            const summaryPrompt = `${promptText}\n\n${fullTranscript}`;
            const result = await withTimeout(ironmic.polishText(summaryPrompt), LLM_TIMEOUT_MS);
            if (result && typeof result === 'string' && !isStubResult(result, promptText)) {
              summary = result;
              llmWorked = true;
              const actionMatch = result.match(/action\s*items?:?\s*([\s\S]*?)(?:$|\n\n)/i);
              if (actionMatch) {
                actionItems = actionMatch[1]
                  .split('\n')
                  .map((l: string) => l.replace(/^[-*•]\s*/, '').trim())
                  .filter((l: string) => l.length > 0);
              }
            }
          }

          if (!llmWorked) {
            summary = fullTranscript;
            actionItems = undefined;
            console.log('[MeetingDetector] LLM unavailable or timed out — use "Summarize Now" later');
          }
        }
      } catch (err) {
        console.warn('[MeetingDetector] Summary generation failed:', err);
        summary = fullTranscript;
      }

      // Update the session with summary if LLM produced one
      if (summary && ironmic?.meetingEnd && this.sessionId) {
        try {
          await ironmic.meetingEnd(
            this.sessionId,
            this.estimatedSpeakerCount,
            summary,
            actionItems ? JSON.stringify(actionItems) : undefined,
            totalDurationMs / 1000,
            undefined,
          );
          if (structuredOutput && ironmic?.meetingSetStructuredOutput) {
            await ironmic.meetingSetStructuredOutput(this.sessionId, JSON.stringify(structuredOutput));
          }
        } catch { /* already saved base session above */ }
      }
    }

    const result: MeetingResult = {
      sessionId: this.sessionId || '',
      segments: this.segments,
      speakerCount: this.estimatedSpeakerCount,
      totalDurationMs,
      summary,
      actionItems,
      structuredOutput,
    };

    this.setState('ended');
    setTimeout(() => {
      this.sessionId = null;
      this.segments = [];
      this.setState('idle');
    }, 1000);

    console.log(`[MeetingDetector] Meeting ended (duration: ${(totalDurationMs / 1000).toFixed(0)}s, segments: ${this.segments.length})`);
    return result;
  }

  private setState(state: MeetingState): void {
    this.state = state;
    for (const cb of this.stateCallbacks) {
      cb(state);
    }
  }
}

/** Singleton instance */
export const meetingDetector = new MeetingDetector();

/**
 * LlmSubprocess — manages the persistent ironmic-llm child process.
 *
 * The ironmic-llm binary runs LLM inference in a separate process to avoid
 * ggml symbol collision with whisper-rs in the main N-API addon.
 *
 * Protocol: JSON commands on stdin, streamed tokens on stdout, __DONE__ sentinel.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface ChatRequest {
  command: 'chat';
  model_path: string;
  model_type: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature: number;
}

interface PolishRequest {
  command: 'polish';
  model_path: string;
  text: string;
}

type LlmRequest = ChatRequest | PolishRequest;

/** Find the ironmic-llm binary. */
function findBinary(): string | null {
  const possiblePaths = [
    // Development path — __dirname is dist/main/ai/, need to go up to project root
    path.join(__dirname, '..', '..', '..', '..', 'rust-core', 'target', 'release', 'ironmic-llm'),
    // Also check via IRONMIC_MODELS_DIR which is set reliably in index.ts
    process.env.IRONMIC_MODELS_DIR
      ? path.join(process.env.IRONMIC_MODELS_DIR, '..', '..', 'target', 'release', 'ironmic-llm')
      : '',
    // Production path (bundled)
    path.join(process.resourcesPath || '', 'ironmic-llm'),
  ].filter(Boolean);
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class LlmSubprocessManager {
  private proc: ChildProcess | null = null;
  private binaryPath: string | null = null;
  private pendingResolve: ((result: string) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingOnToken: ((token: string) => void) | null = null;
  private outputBuffer = '';
  private requestQueue: Array<{
    request: LlmRequest;
    onToken?: (token: string) => void;
    resolve: (result: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private busy = false;

  /** Check if the binary exists. */
  isAvailable(): boolean {
    if (!this.binaryPath) this.binaryPath = findBinary();
    return this.binaryPath !== null;
  }

  /** Get the binary path. */
  getBinaryPath(): string | null {
    if (!this.binaryPath) this.binaryPath = findBinary();
    return this.binaryPath;
  }

  /** Ensure the subprocess is running. */
  private ensureProcess(): ChildProcess {
    if (this.proc && !this.proc.killed) return this.proc;

    const binary = this.getBinaryPath();
    if (!binary) {
      throw new Error('ironmic-llm binary not found. Build it with: cargo build --release --bin ironmic-llm --features llm-bin');
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[llm-subprocess] Spawning: ${binary}`);
    }

    this.proc = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        IRONMIC_MODELS_DIR: process.env.IRONMIC_MODELS_DIR || '',
      },
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      if (process.env.NODE_ENV === 'development') {
        // Filter out model loading noise — only show errors/warnings
        const text = chunk.toString();
        if (text.includes('ERROR') || text.includes('WARN') || text.includes('INFO ironmic')) {
          console.error(`[llm-subprocess] ${text.trim()}`);
        }
      }
    });

    this.proc.on('error', (err) => {
      console.error(`[llm-subprocess] Process error: ${err.message}`);
      if (this.pendingReject) {
        this.pendingReject(new Error(`LLM subprocess error: ${err.message}`));
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingOnToken = null;
      }
      this.proc = null;
    });

    this.proc.on('close', (code) => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`[llm-subprocess] Process exited with code ${code}`);
      }
      if (this.pendingReject) {
        this.pendingReject(new Error(`LLM subprocess exited unexpectedly (code ${code})`));
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingOnToken = null;
      }
      this.proc = null;
      this.busy = false;
      // Process next queued request
      this.processQueue();
    });

    return this.proc;
  }

  /** Handle stdout data from the subprocess. */
  private handleStdout(data: string) {
    this.outputBuffer += data;

    // Check for __DONE__ sentinel
    const doneIdx = this.outputBuffer.indexOf('__DONE__');
    const errorIdx = this.outputBuffer.indexOf('__ERROR__:');

    if (errorIdx !== -1) {
      const errorEnd = this.outputBuffer.indexOf('\n', errorIdx);
      const errorMsg = errorEnd !== -1
        ? this.outputBuffer.substring(errorIdx + '__ERROR__:'.length, errorEnd)
        : this.outputBuffer.substring(errorIdx + '__ERROR__:'.length);

      if (this.pendingReject) {
        this.pendingReject(new Error(errorMsg.trim()));
      }
      this.outputBuffer = '';
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingOnToken = null;
      this.busy = false;
      this.processQueue();
      return;
    }

    if (doneIdx !== -1) {
      // Extract the full response (everything before __DONE__)
      const fullResponse = this.outputBuffer.substring(0, doneIdx).trim();

      if (this.pendingResolve) {
        this.pendingResolve(fullResponse);
      }
      this.outputBuffer = '';
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingOnToken = null;
      this.busy = false;
      this.processQueue();
      return;
    }

    // Stream tokens to callback as they arrive
    if (this.pendingOnToken && data.length > 0) {
      this.pendingOnToken(data);
    }
  }

  /** Process the next request in the queue. */
  private processQueue() {
    if (this.busy || this.requestQueue.length === 0) return;

    const { request, onToken, resolve, reject } = this.requestQueue.shift()!;
    this.executeRequest(request, onToken, resolve, reject);
  }

  /** Execute a request against the subprocess. */
  private executeRequest(
    request: LlmRequest,
    onToken: ((token: string) => void) | undefined,
    resolve: (result: string) => void,
    reject: (err: Error) => void,
  ) {
    this.busy = true;
    this.outputBuffer = '';
    this.pendingResolve = resolve;
    this.pendingReject = reject;
    this.pendingOnToken = onToken || null;

    try {
      const proc = this.ensureProcess();
      const json = JSON.stringify(request) + '\n';
      proc.stdin?.write(json);
    } catch (err: unknown) {
      this.busy = false;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Send a request (queued if busy). */
  private sendRequest(
    request: LlmRequest,
    onToken?: (token: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.busy) {
        this.requestQueue.push({ request, onToken, resolve, reject });
      } else {
        this.executeRequest(request, onToken, resolve, reject);
      }
    });
  }

  /** Run chat completion. */
  async chatComplete(
    params: {
      modelPath: string;
      modelType: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens: number;
      temperature: number;
    },
    onToken?: (token: string) => void,
  ): Promise<string> {
    return this.sendRequest(
      {
        command: 'chat',
        model_path: params.modelPath,
        model_type: params.modelType,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
      },
      onToken,
    );
  }

  /** Run text polishing. */
  async polishText(text: string, modelPath: string): Promise<string> {
    return this.sendRequest({
      command: 'polish',
      model_path: modelPath,
      text,
    });
  }

  /** Kill the subprocess. */
  kill() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.busy = false;
    this.requestQueue = [];
  }
}

// Singleton
export const llmSubprocess = new LlmSubprocessManager();

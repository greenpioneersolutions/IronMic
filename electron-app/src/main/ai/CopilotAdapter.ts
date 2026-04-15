import { execSync } from 'child_process';
import type { ICLIAdapter, ParsedOutput, AIProvider, AIModel } from './types';

/** Cached binary info to avoid repeated which/where calls */
let cachedBinary: { path: string; isStandalone: boolean } | null = null;

/** Clear the cached binary path (called on auth refresh). */
export function clearCopilotCache(): void {
  cachedBinary = null;
}

export class CopilotAdapter implements ICLIAdapter {
  name: AIProvider = 'copilot';

  async isInstalled(): Promise<boolean> {
    try {
      const info = findCopilotBinary();
      return info !== null;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // Check env vars first
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;

      const info = findCopilotBinary();
      if (!info) return false;

      if (info.isStandalone) {
        // Standalone `copilot` CLI — check if it responds
        try {
          execSync('copilot --version 2>&1', {
            encoding: 'utf-8',
            timeout: 5000,
            shell: process.env.SHELL || '/bin/zsh',
          });
          return true; // If it runs without error, it's authenticated
        } catch {
          return false;
        }
      }

      // gh CLI — check gh auth status
      try {
        const result = execSync('gh auth status 2>&1', {
          encoding: 'utf-8',
          timeout: 5000,
          shell: process.env.SHELL || '/bin/zsh',
        });
        return result.includes('Logged in');
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const info = findCopilotBinary();
      if (!info) return null;

      const cmd = info.isStandalone
        ? 'copilot --version 2>/dev/null'
        : 'gh copilot --version 2>/dev/null || gh --version 2>/dev/null';
      const result = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        shell: process.env.SHELL || '/bin/zsh',
      });
      const match = result.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async getBinaryPath(): Promise<string | null> {
    const info = findCopilotBinary();
    return info?.path || null;
  }

  buildArgs(prompt: string, _continueSession: boolean, model?: string): string[] {
    const info = findCopilotBinary();

    if (info?.isStandalone) {
      // Standalone `copilot` CLI
      const args: string[] = [];
      if (model) args.push('--model', model);
      args.push(prompt);
      return args;
    }

    // gh CLI — `gh copilot suggest`
    const args = ['copilot', 'suggest', '-t', 'shell'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return args;
  }

  availableModels(): AIModel[] {
    return [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'copilot', free: true, description: 'Free with GitHub — fast and capable' },
      { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'copilot', free: false, description: 'Most capable GPT model' },
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'copilot', free: false, description: 'Multimodal, fast' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'copilot', free: true, description: 'Lightweight and free' },
      { id: 'o3-mini', label: 'o3-mini', provider: 'copilot', free: false, description: 'Advanced reasoning' },
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'copilot', free: false, description: 'Anthropic via GitHub Models' },
    ];
  }

  parseOutput(data: string): ParsedOutput {
    const trimmed = data.trim();
    if (!trimmed) return { type: 'text', content: '' };
    if (trimmed.startsWith('Error') || trimmed.startsWith('error')) {
      return { type: 'error', content: trimmed };
    }
    return { type: 'text', content: trimmed };
  }
}

/**
 * Find the Copilot CLI binary.
 * Checks for standalone `copilot` first, then `gh` (GitHub CLI with copilot extension).
 */
function findCopilotBinary(): { path: string; isStandalone: boolean } | null {
  if (cachedBinary) return cachedBinary;

  const shell = process.env.SHELL || '/bin/zsh';
  const opts = { encoding: 'utf-8' as const, timeout: 3000, shell };

  // Check for standalone `copilot` CLI first
  try {
    const result = execSync('which copilot 2>/dev/null', opts).trim();
    if (result) {
      cachedBinary = { path: result, isStandalone: true };
      return cachedBinary;
    }
  } catch { /* not found */ }

  // Check for `gh` CLI
  try {
    const result = execSync('which gh 2>/dev/null', opts).trim();
    if (result) {
      cachedBinary = { path: result, isStandalone: false };
      return cachedBinary;
    }
  } catch { /* not found */ }

  return null;
}

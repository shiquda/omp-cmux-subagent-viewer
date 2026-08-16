// CmuxClient: thin typed wrapper around the `cmux` CLI. All interaction goes
// through the injected CommandRunner so unit tests can verify argv against a
// fake executor instead of a live cmux socket. Every command is fail-open:
// callers catch errors and degrade, never affect OMP execution.

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  exec(argv: string[]): Promise<CommandResult>;
}

export interface CmuxIdentifyOutput {
  caller?: {
    workspace_ref?: string;
    workspace_id?: string;
    surface_ref?: string;
    surface_id?: string;
    pane_ref?: string;
    window_ref?: string;
  };
  focused?: {
    workspace_ref?: string;
  };
  socket_path?: string;
  app_cli_path?: string;
}

export interface CmuxPane {
  ref: string;
  surfaces: number;
  focused: boolean;
}

export interface CmuxSurface {
  ref: string;
  title: string;
  selected: boolean;
}

export interface CmuxCapabilities {
  capabilities: string[];
}

export class CmuxError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CmuxError";
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Parse `cmux list-panes` text output lines like `* pane:8  [1 surface]  [focused]`. */
export function parsePaneLine(line: string): CmuxPane | null {
  const match = /^\*?\s*(pane:\S+)\s+\[(\d+)\s+surface[s]?\]\s*(\[focused\])?/.exec(line.trim());
  if (!match) return null;
  return { ref: match[1], surfaces: Number(match[2]), focused: Boolean(match[3]) };
}

/** Parse `cmux list-pane-surfaces` lines like `* surface:8  π ⠹ Title  [selected]`. */
export function parseSurfaceLine(line: string): CmuxSurface | null {
  const trimmed = line.trim();
  const match = /^(\*?\s*)(surface:\S+)\s+(.*)$/.exec(trimmed);
  if (!match) return null;
  const ref = match[2];
  let titlePart = match[3];
  let selected = false;
  const selMatch = /\s+\[selected\]\s*$/.exec(titlePart);
  if (selMatch) {
    selected = true;
    titlePart = titlePart.slice(0, selMatch.index);
  } else {
    titlePart = titlePart.replace(/\s+\[\w+\]\s*$/, "");
  }
  return { ref, title: titlePart.trim(), selected };
}

export class CmuxClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cmuxBin = "cmux",
  ) {}

  private async run(args: string[]): Promise<CommandResult> {
    const result = await this.runner.exec([this.cmuxBin, ...args]);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || "unknown error";
      throw new CmuxError(`cmux ${args[0]} failed: ${detail}`, result.code, result.stderr);
    }
    return result;
  }

  async identify(): Promise<CmuxIdentifyOutput | null> {
    try {
      const { stdout } = await this.run(["identify", "--id-format", "both", "--json"]);
      const parsed = JSON.parse(stdout) as CmuxIdentifyOutput;
      return parsed;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async capabilities(): Promise<string[]> {
    try {
      const { stdout } = await this.run(["capabilities", "--json"]);
      const parsed = JSON.parse(stdout) as CmuxCapabilities;
      return parsed.capabilities ?? [];
    } catch {
      return [];
    }
  }

  /** Create a helper pane to the right. Returns pane ref like `pane:9` (or null on failure). */
  async createHelperPane(workspace: string, direction = "right"): Promise<string | null> {
    try {
      const { stdout } = await this.run([
        "new-pane",
        "--type", "terminal",
        "--direction", direction,
        "--workspace", workspace,
        "--focus", "false",
      ]);
      const line = stdout.trim().split("\n").find((l) => l.includes("pane:"));
      if (!line) return null;
      const match = /pane:\d+/.exec(line);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  async listPanes(workspace: string): Promise<CmuxPane[]> {
    try {
      const { stdout } = await this.run(["list-panes", "--workspace", workspace]);
      return stdout
        .split("\n")
        .map(parsePaneLine)
        .filter((p): p is CmuxPane => p !== null);
    } catch {
      return [];
    }
  }

  async listPaneSurfaces(workspace: string, pane: string): Promise<CmuxSurface[]> {
    try {
      const { stdout } = await this.run(["list-pane-surfaces", "--workspace", workspace, "--pane", pane]);
      return stdout
        .split("\n")
        .map(parseSurfaceLine)
        .filter((s): s is CmuxSurface => s !== null);
    } catch {
      return [];
    }
  }

  /** Create a terminal surface inside `pane`. Returns surface ref or null. */
  async createSurface(workspace: string, pane: string, cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.run([
        "new-surface",
        "--type", "terminal",
        "--pane", pane,
        "--workspace", workspace,
        "--working-directory", cwd,
        "--focus", "false",
      ]);
      const line = stdout.trim().split("\n").find((l) => l.includes("surface:"));
      const match = line ? /surface:\d+/.exec(line) : null;
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  /** Wait until the surface shell is interactive, then return. */
  async waitForShell(workspace: string, surface: string, timeoutMs = 12_000): Promise<boolean> {
    // Backdrop surfaces render lazily and the login banner can swallow early
    // input. Give the banner time to print, then send a harmless probe: its
    // success marker proves both rendering and an interactive shell.
    // NOTE: cmux send does NOT append Enter; the command text needs a literal
    // "\n" so the shell executes it.
    await sleep(1500);
    try {
      await this.run(["send", "--workspace", workspace, "--surface", surface, "true\n"]);
    } catch {
      // fall through to polling anyway
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.run(["read-screen", "--workspace", workspace, "--surface", surface, "--lines", "8"]);
        // A shell prompt character (➜ ❯ ❮ or vanilla zsh %) proves the
        // interactive shell is up — the login banner alone never shows one.
        if (/[➜❯❮%]/.test(stdout)) return true;
      } catch {
        // surface not readable yet — keep polling
      }
      await sleep(300);
    }
    return false;
  }

  /** Wait for the shell, then run a command in the surface. Returns success. */
  async runCommand(workspace: string, surface: string, command: string, waitMs = 12_000): Promise<boolean> {
    if (!(await this.waitForShell(workspace, surface, waitMs))) return false;
    try {
      await this.run(["send", "--workspace", workspace, "--surface", surface, `${command}\n`]);
      return true;
    } catch {
      return false;
    }
  }

  async renameSurface(workspace: string, surface: string, title: string): Promise<boolean> {
    try {
      await this.run(["rename-tab", "--workspace", workspace, "--surface", surface, title]);
      return true;
    } catch {
      return false;
    }
  }

  async closeSurface(workspace: string, surface: string): Promise<boolean> {
    try {
      await this.run(["close-surface", "--workspace", workspace, "--surface", surface]);
      return true;
    } catch {
      return false;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.run(["ping"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Close a workspace (used by the smoke test cleanup path). */
  async closeWorkspace(workspace: string): Promise<boolean> {
    try {
      await this.run(["close-workspace", "--workspace", workspace]);
      return true;
    } catch {
      return false;
    }
  }

  /** Smoke cleanup: close the workspace, tolerating failure. */
  async runCleanup(workspace: string): Promise<boolean> {
    return this.closeWorkspace(workspace);
  }
}

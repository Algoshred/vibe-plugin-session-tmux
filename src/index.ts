/**
 * @burdenoff/vibe-plugin-session-tmux
 *
 * Tmux + ttyd session provider plugin for VibeControls Agent.
 * Implements the full SessionProvider interface (23 methods) using tmux for
 * terminal session management and ttyd for browser-accessible web terminals.
 *
 * Migrated to consume @vibecontrols/plugin-sdk@2026.509.1 — inline contract
 * stubs and subprocess/storage helpers replaced by SDK imports.
 */

import { Elysia } from "elysia";
import type {
  HostServices,
  VibePlugin,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { TypedStore } from "@vibecontrols/plugin-sdk/storage";
import {
  findAvailablePort,
  gracefulKill,
  isProcessAlive,
  sleep,
} from "@vibecontrols/plugin-sdk/subprocess";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { TelemetryEmitter } from "@vibecontrols/plugin-sdk/telemetry";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";

// ---------------------------------------------------------------------------
// Plugin-local types (session domain — not part of SDK contract)
// ---------------------------------------------------------------------------

type SessionStatus = "active" | "inactive" | "terminated" | "error";

interface SessionConfig {
  /** Optional external ID (e.g. backend UUID). If provided the plugin uses it instead of generating one. */
  id?: string;
  name: string;
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  shell?: string;
  size?: { cols: number; rows: number };
  projectId?: string;
  /** Optional provider-native session name. See manager docs. */
  externalName?: string;
}

interface SessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  provider: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  projectId?: string;
  createdAt: string;
  updatedAt?: string;
  terminal?: TerminalInfo;
  metadata?: Record<string, unknown>;
}

interface TerminalInfo {
  url: string;
  port: number;
  pid: number;
}

interface HealthCheckResult {
  ok: boolean;
  sessions: number;
  terminals: number;
  message?: string;
}

interface SystemSessionInfo {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SystemTerminalInfo {
  pid: number;
  port: number;
  sessionId?: string;
}

interface SessionProvider {
  readonly name: string;
  create(config: SessionConfig): Promise<SessionInfo>;
  terminate(sessionId: string): Promise<void>;
  getInfo(sessionId: string): Promise<SessionInfo | null>;
  list(): Promise<SessionInfo[]>;
  sendCommand(sessionId: string, command: string): Promise<void>;
  sendKeys(sessionId: string, keys: string): Promise<void>;
  sendInterrupt(sessionId: string): Promise<void>;
  captureOutput(sessionId: string): Promise<string>;
  rename(sessionId: string, newName: string): Promise<void>;
  toggleMouse(sessionId: string): Promise<boolean>;
  getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }>;
  getTerminalInfo(sessionId: string): Promise<TerminalInfo | null>;
  startTerminal(sessionId: string, port?: number): Promise<TerminalInfo>;
  stopTerminal(sessionId: string): Promise<void>;
  listSystemSessions(): Promise<SystemSessionInfo[]>;
  listSystemTerminals(): Promise<SystemTerminalInfo[]>;
  bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }>;
  bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }>;
  healthCheck(): Promise<HealthCheckResult>;
  getSessionsByProject(projectId: string): Promise<SessionInfo[]>;
  cleanup(): Promise<{ cleaned: number }>;

  // Core agent interface aliases (routes use these names)
  get(sessionId: string): Promise<SessionInfo | null>;
  kill(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  capture(
    sessionId: string,
    options?: { lines?: number; pane?: string },
  ): Promise<string>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  listSystem(): Promise<SystemSessionInfo[]>;
  killSystem(sessionId: string): Promise<void>;
  killSystemTerminal(pid: number): Promise<void>;

  // Optional capability & extended capture methods
  getCapabilities?(): SessionProviderCapabilities;
  getScrollback?(sessionId: string, lines: number): Promise<string>;
  searchOutput?(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>>;

  // Optional orphan discovery / adoption (daemon-backed providers)
  discoverOrphans?(): Promise<OrphanSessionInfo[]>;
  adopt?(externalName: string, displayName?: string): Promise<SessionInfo>;
}

interface OrphanSessionInfo {
  externalName: string;
  provider: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SessionProviderCapabilities {
  provider: string;
  features: {
    mouse: boolean;
    resize: boolean;
    capture: boolean;
    webTerminal: boolean;
    splitPanes: boolean;
    tabs: boolean;
    scrollback: boolean;
    clipboard: boolean;
    search: boolean;
  };
  platform: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "session-tmux";
const PLUGIN_VERSION = "2.3.0";
const PROVIDER_NAME = "session-tmux";
const STORAGE_NAMESPACE = "session-tmux";
const STORAGE_KEY_SESSIONS = "sessions";
const STORAGE_KEY_TERMINALS = "terminals";
const TTYD_BASE_PORT = 7681;
const TTYD_PORT_RANGE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short random hex ID (8 chars) for session identifiers.
 */
function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Execute a tmux command and return its stdout. Throws on non-zero exit.
 */
function tmuxExec(args: string[]): string {
  const result = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`tmux exited with code ${result.exitCode}: ${stderr}`);
  }
  return result.stdout.toString("utf-8").trimEnd();
}

/**
 * Execute a tmux command, returning true on success, false on failure.
 * Does not throw.
 */
function tmuxExecSilent(args: string[]): boolean {
  try {
    const result = Bun.spawnSync(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the current ISO timestamp.
 */
function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// TmuxSessionProvider
// ---------------------------------------------------------------------------

interface PersistedTerminal {
  pid: number;
  port: number;
}

class TmuxSessionProvider implements SessionProvider {
  readonly name = PROVIDER_NAME;

  /** Logger — bound to plugin source; no-op until init() supplies host logger. */
  private log: BoundLogger = new BoundLogger(undefined, PLUGIN_NAME);

  /** TypedStore handles — assigned in init() once host storage is available. */
  private sessionsStore: TypedStore<SessionInfo[]> | null = null;
  private terminalsStore: TypedStore<Record<string, PersistedTerminal>> | null =
    null;

  /** In-memory map of ttyd PIDs keyed by session ID. */
  private ttydPids: Map<string, number> = new Map();

  /** In-memory map of ttyd port assignments keyed by session ID. */
  private ttydPorts: Map<string, number> = new Map();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the provider with host services. Called from onServerStart.
   */
  async init(services: HostServices): Promise<void> {
    this.log = new BoundLogger(services.logger, PLUGIN_NAME);

    if (services.storage) {
      this.sessionsStore = new TypedStore<SessionInfo[]>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
        services.logger,
        PLUGIN_NAME,
      );
      this.terminalsStore = new TypedStore<Record<string, PersistedTerminal>>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_TERMINALS,
        services.logger,
        PLUGIN_NAME,
      );
    }

    this.log.info("TmuxSessionProvider initialising", { provider: this.name });

    // Verify tmux is available
    try {
      const version = tmuxExec(["-V"]);
      this.log.info("tmux detected", { version });
    } catch {
      this.log.error(
        "tmux is not installed or not in PATH — session provider will not function",
      );
    }

    // Reconcile persisted sessions against actual tmux state
    await this.reconcileSessions();

    this.log.info("TmuxSessionProvider ready");
  }

  /**
   * Graceful shutdown: stop all ttyd terminals.
   */
  async shutdown(context?: { reason: "reload" | "shutdown" }): Promise<void> {
    if (context?.reason === "reload") {
      this.log.info("Hot-reload: preserving tmux sessions and ttyd processes");
      await this.persistTerminals();
      this.ttydPids.clear();
      this.ttydPorts.clear();
      return;
    }

    this.log.info("TmuxSessionProvider shutting down — stopping terminals");
    const stopPromises: Promise<void>[] = [];
    for (const [sessionId] of this.ttydPids) {
      stopPromises.push(this.stopTerminal(sessionId));
    }
    await Promise.allSettled(stopPromises);
    try {
      await this.terminalsStore?.delete();
    } catch {
      /* ignore */
    }
    this.log.info("TmuxSessionProvider shutdown complete");
  }

  // -----------------------------------------------------------------------
  // SessionProvider — create / terminate / getInfo / list
  // -----------------------------------------------------------------------

  async create(config: SessionConfig): Promise<SessionInfo> {
    // Attach-or-create: if caller supplied a provider-native name and a
    // matching tmux session already exists on the host, hand off to
    // adopt() so the agent and any external tmux user share the same
    // session. If no match, create with that exact name.
    if (config.externalName) {
      const target = config.externalName;
      if (
        target.length === 0 ||
        target.length > 128 ||
        /[\0\r\n:.\s]/.test(target)
      ) {
        throw new Error(`Invalid externalName: ${target}`);
      }
      if (tmuxExecSilent(["has-session", "-t", target])) {
        this.log.info("create(): attaching to existing tmux session", {
          target,
        });
        return this.adopt(target, config.name);
      }
      // No matching session — create with the exact requested name.
      const now = nowISO();
      const args: string[] = ["new-session", "-d", "-s", target];
      if (config.workingDirectory) args.push("-c", config.workingDirectory);
      if (config.size)
        args.push(
          "-x",
          String(config.size.cols),
          "-y",
          String(config.size.rows),
        );
      if (config.shell) args.push(config.shell);
      tmuxExec(args);
      if (config.environment) {
        for (const [k, v] of Object.entries(config.environment)) {
          tmuxExecSilent(["set-environment", "-t", target, k, v]);
        }
      }
      tmuxExecSilent(["set", "-t", target, "mouse", "on"]);
      if (config.command)
        tmuxExecSilent(["send-keys", "-t", target, config.command, "Enter"]);
      const id = target.startsWith("vibe-")
        ? target.slice(5) || target
        : target;
      const pid = this.getSessionPanePid(target);
      const info: SessionInfo = {
        id,
        name: config.name,
        status: "active",
        provider: this.name,
        command: config.command,
        workingDirectory: config.workingDirectory,
        pid: pid ?? undefined,
        projectId: config.projectId,
        createdAt: now,
        updatedAt: now,
        metadata: {
          tmuxSessionName: target,
          shell: config.shell,
          size: config.size,
          createdWithExplicitName: true,
        },
      };
      await this.saveSession(info);
      this.log.info("Tmux session created with explicit name", {
        id,
        target,
      });
      return info;
    }

    const id = config.id || generateId();
    const sessionName = `vibe-${id.substring(0, 8)}`;
    const now = nowISO();

    this.log.info("Creating tmux session", {
      id,
      name: config.name,
      sessionName,
    });

    // Build tmux new-session command
    const args: string[] = ["new-session", "-d", "-s", sessionName];

    if (config.workingDirectory) {
      args.push("-c", config.workingDirectory);
    }

    if (config.size) {
      args.push("-x", String(config.size.cols), "-y", String(config.size.rows));
    }

    // If a shell is specified, use it as the window command
    if (config.shell) {
      args.push(config.shell);
    }

    try {
      tmuxExec(args);
    } catch (err) {
      this.log.error("Failed to create tmux session", {
        id,
        error: String(err),
      });
      throw new Error(`Failed to create tmux session: ${err}`, { cause: err });
    }

    // Apply environment variables
    if (config.environment) {
      for (const [key, value] of Object.entries(config.environment)) {
        tmuxExecSilent(["set-environment", "-t", sessionName, key, value]);
      }
    }

    // Enable mouse by default
    tmuxExecSilent(["set", "-t", sessionName, "mouse", "on"]);

    // If an initial command is given, send it
    if (config.command) {
      tmuxExecSilent(["send-keys", "-t", sessionName, config.command, "Enter"]);
    }

    // Get the PID of the session's first pane
    const pid = this.getSessionPanePid(sessionName);

    const info: SessionInfo = {
      id,
      name: config.name,
      status: "active",
      provider: this.name,
      command: config.command,
      workingDirectory: config.workingDirectory,
      pid: pid ?? undefined,
      projectId: config.projectId,
      createdAt: now,
      updatedAt: now,
      metadata: {
        tmuxSessionName: sessionName,
        shell: config.shell,
        size: config.size,
      },
    };

    await this.saveSession(info);

    this.log.info("Tmux session created", { id, sessionName, pid });
    return info;
  }

  async terminate(sessionId: string): Promise<void> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      this.log.warn("Terminate called for unknown session", { sessionId });
      return;
    }

    const tmuxName = this.getTmuxName(session);
    this.log.info("Terminating tmux session", {
      sessionId,
      tmuxName,
    });

    // Stop terminal first if running
    if (this.ttydPids.has(sessionId)) {
      await this.stopTerminal(sessionId);
    }

    // Kill the tmux session
    tmuxExecSilent(["kill-session", "-t", tmuxName]);

    // Update stored state
    session.status = "terminated";
    session.updatedAt = nowISO();
    session.terminal = undefined;
    await this.saveSession(session);

    this.log.info("Tmux session terminated", { sessionId });
  }

  async getInfo(sessionId: string): Promise<SessionInfo | null> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId) ?? null;

    if (session) {
      // Refresh live status from tmux
      const tmuxName = this.getTmuxName(session);
      const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      } else if (exists && session.status === "inactive") {
        session.status = "active";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      }

      // Attach terminal info if running
      const termInfo = this.getRunningTerminalInfo(sessionId);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }

    return session;
  }

  async list(): Promise<SessionInfo[]> {
    const sessions = await this.loadSessions();
    // Refresh statuses
    for (const session of sessions) {
      if (session.status === "terminated") continue;
      const tmuxName = this.getTmuxName(session);
      const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
      } else if (exists && session.status !== "active") {
        session.status = "active";
        session.updatedAt = nowISO();
      }
      // Attach terminal info
      const termInfo = this.getRunningTerminalInfo(session.id);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }
    await this.saveSessions(sessions);
    return sessions;
  }

  // -----------------------------------------------------------------------
  // SessionProvider — command / keys / interrupt / capture
  // -----------------------------------------------------------------------

  async sendCommand(sessionId: string, command: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.debug("Sending command", { sessionId, command });
    try {
      tmuxExec(["send-keys", "-t", tmuxName, command, "Enter"]);
    } catch (err) {
      this.log.error("Failed to send command", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send command to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async sendKeys(sessionId: string, keys: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.debug("Sending keys", { sessionId, keys });
    try {
      tmuxExec(["send-keys", "-t", tmuxName, keys]);
    } catch (err) {
      this.log.error("Failed to send keys", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to send keys to session ${sessionId}: ${err}`, {
        cause: err,
      });
    }
  }

  async sendInterrupt(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.debug("Sending interrupt (C-c)", { sessionId });
    try {
      tmuxExec(["send-keys", "-t", tmuxName, "C-c"]);
    } catch (err) {
      this.log.error("Failed to send interrupt", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send interrupt to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async captureOutput(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.debug("Capturing output", { sessionId });
    try {
      const output = tmuxExec(["capture-pane", "-t", tmuxName, "-p"]);
      return output;
    } catch (err) {
      this.log.error("Failed to capture output", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to capture output from session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  // -----------------------------------------------------------------------
  // SessionProvider — rename / toggleMouse / getTerminationStatus
  // -----------------------------------------------------------------------

  async rename(sessionId: string, newName: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.info("Renaming session", {
      sessionId,
      from: session.name,
      to: newName,
    });

    try {
      // Rename the display name in our records (not the tmux session name,
      // which is vibe-{id} and must stay stable for lookups)
      session.name = newName;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    } catch (err) {
      this.log.error("Failed to rename session", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to rename session ${sessionId}: ${err}`, {
        cause: err,
      });
    }

    // Also rename the tmux session for cosmetic purposes
    const newTmuxName = `vibe-${session.id}`;
    tmuxExecSilent(["rename-session", "-t", tmuxName, newTmuxName]);
  }

  async toggleMouse(sessionId: string): Promise<boolean> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    // Read current mouse setting
    let mouseOn: boolean;
    try {
      const value = tmuxExec(["show-options", "-t", tmuxName, "-v", "mouse"]);
      mouseOn = value.trim() === "on";
    } catch {
      // Default to off if we can't read
      mouseOn = false;
    }

    const newState = mouseOn ? "off" : "on";
    tmuxExecSilent(["set", "-t", tmuxName, "mouse", newState]);

    this.log.debug("Toggled mouse", { sessionId, mouse: newState });
    return newState === "on";
  }

  async getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      return { terminated: true, exists: false };
    }

    const tmuxName = this.getTmuxName(session);
    const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);

    return {
      terminated: session.status === "terminated" || !exists,
      exists,
    };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — terminal (ttyd) management
  // -----------------------------------------------------------------------

  async getTerminalInfo(sessionId: string): Promise<TerminalInfo | null> {
    return this.getRunningTerminalInfo(sessionId);
  }

  async startTerminal(sessionId: string, port?: number): Promise<TerminalInfo> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    // If already running, return existing info
    const existing = this.getRunningTerminalInfo(sessionId);
    if (existing) {
      this.log.debug("Terminal already running", { sessionId, ...existing });
      return existing;
    }

    // Find available port via SDK helper
    const assignedPort =
      port ?? (await findAvailablePort(TTYD_BASE_PORT, TTYD_PORT_RANGE));

    this.log.info("Starting ttyd terminal", {
      sessionId,
      tmuxName,
      port: assignedPort,
    });

    // Build the ttyd shell environment.
    // Set tmux-identifying vars, and strip other providers' vars if the
    // agent happens to run inside wezterm/screen/zellij.
    const ttydEnv: Record<string, string | undefined> = { ...process.env };
    ttydEnv.VIBECONTROLS_PROVIDER = "tmux";

    const otherProviderVars: Record<string, string[]> = {
      wezterm: ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"],
      screen: ["STY", "WINDOW"],
      zellij: ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"],
    };
    for (const vars of Object.values(otherProviderVars)) {
      for (const v of vars) {
        if (v in ttydEnv) delete ttydEnv[v];
      }
    }

    const child = Bun.spawn(
      [
        "ttyd",
        "-t",
        "fontSize=14",
        "-t",
        `theme={"background":"#1e1e1e","foreground":"#cccccc"}`,
        "--writable",
        "--port",
        String(assignedPort),
        "tmux",
        "attach",
        "-t",
        tmuxName,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: ttydEnv as Record<string, string>,
      },
    );

    if (!child.pid) {
      throw new Error("Failed to start ttyd — no PID returned");
    }

    // Give ttyd a moment to bind the port
    await sleep(500);

    // Store references
    this.ttydPids.set(sessionId, child.pid);
    this.ttydPorts.set(sessionId, assignedPort);
    await this.persistTerminals();

    const terminalInfo: TerminalInfo = {
      url: `http://localhost:${assignedPort}`,
      port: assignedPort,
      pid: child.pid,
    };

    // Update session record with terminal info
    session.terminal = terminalInfo;
    session.updatedAt = nowISO();
    await this.saveSession(session);

    this.log.info("ttyd terminal started", {
      sessionId,
      port: assignedPort,
      pid: child.pid,
    });

    return terminalInfo;
  }

  async stopTerminal(sessionId: string): Promise<void> {
    const pid = this.ttydPids.get(sessionId);
    if (!pid) {
      this.log.debug("No ttyd process found for session", { sessionId });
      return;
    }

    this.log.info("Stopping ttyd terminal", {
      sessionId,
      pid,
    });

    await gracefulKill(pid);

    this.ttydPids.delete(sessionId);
    this.ttydPorts.delete(sessionId);
    await this.persistTerminals();

    // Clear terminal from session record
    const session = await this.getInfo(sessionId);
    if (session) {
      session.terminal = undefined;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    }

    this.log.info("ttyd terminal stopped", { sessionId });
  }

  // -----------------------------------------------------------------------
  // SessionProvider — system-level listing and bulk operations
  // -----------------------------------------------------------------------

  async listSystemSessions(): Promise<SystemSessionInfo[]> {
    try {
      const raw = tmuxExec([
        "list-sessions",
        "-F",
        "#{session_id}:#{session_name}:#{session_windows}:#{session_attached}:#{session_created}",
      ]);

      if (!raw) return [];

      return raw.split("\n").map((line) => {
        const [id, name, windows, attached, created] = line.split(":");
        return {
          id: id ?? "",
          name: name ?? "",
          windows: parseInt(windows ?? "0", 10),
          attached: attached === "1",
          createdAt: created
            ? new Date(parseInt(created, 10) * 1000).toISOString()
            : undefined,
        };
      });
    } catch {
      // tmux list-sessions fails when there are no sessions
      return [];
    }
  }

  async listSystemTerminals(): Promise<SystemTerminalInfo[]> {
    const terminals: SystemTerminalInfo[] = [];

    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (pid && port !== undefined) {
        terminals.push({
          pid,
          port,
          sessionId,
        });
      }
    }

    // Also look for any orphaned ttyd processes via pgrep
    try {
      const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      const raw = pgrepResult.stdout.toString().trim();

      if (raw) {
        for (const line of raw.split("\n")) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0] ?? "0", 10);
          if (!pid) continue;

          // Skip already-tracked processes
          if ([...this.ttydPids.values()].includes(pid)) continue;

          // Try to extract port from command line
          const portIdx = parts.indexOf("--port");
          const port =
            portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;

          terminals.push({ pid, port: port || 0 });
        }
      }
    } catch {
      // pgrep returns non-zero when no processes found — that's fine
    }

    return terminals;
  }

  async bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    for (const sid of sessionIds) {
      const success = tmuxExecSilent(["kill-session", "-t", sid]);
      if (success) {
        killed++;
      } else {
        failed++;
      }
    }

    this.log.info("Bulk kill system sessions", { killed, failed });
    return { killed, failed };
  }

  async bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    const killPromises = pids.map(async (pid) => {
      try {
        await gracefulKill(pid);
        killed++;

        // Remove from tracked processes if present
        for (const [sessionId, trackedPid] of this.ttydPids) {
          if (trackedPid === pid) {
            this.ttydPids.delete(sessionId);
            this.ttydPorts.delete(sessionId);
            break;
          }
        }
      } catch {
        failed++;
      }
    });

    await Promise.allSettled(killPromises);

    this.log.info("Bulk kill system terminals", { killed, failed });
    return { killed, failed };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — health / project filter / cleanup
  // -----------------------------------------------------------------------

  async healthCheck(): Promise<HealthCheckResult> {
    let tmuxOk: boolean;
    let tmuxVersion: string;
    let sessionCount = 0;
    const terminalCount = this.ttydPids.size;

    try {
      tmuxVersion = tmuxExec(["-V"]);
      tmuxOk = true;
    } catch {
      return {
        ok: false,
        sessions: 0,
        terminals: terminalCount,
        message: "tmux is not available",
      };
    }

    try {
      const sysSessions = await this.listSystemSessions();
      sessionCount = sysSessions.length;
    } catch {
      // Ignore — zero sessions
    }

    // Check ttyd availability
    // (tmux/ttyd themselves are POSIX-only — Windows users should run
    // this plugin under WSL2 — but the discovery probe stays portable.)
    let ttydOk = false;
    try {
      ttydOk = Bun.which("ttyd") !== null;
    } catch {
      // ttyd not found
    }

    const messages: string[] = [tmuxVersion];
    if (!ttydOk) {
      messages.push("ttyd not found — web terminals unavailable");
    }

    return {
      ok: tmuxOk,
      sessions: sessionCount,
      terminals: terminalCount,
      message: messages.join("; "),
    };
  }

  async getSessionsByProject(projectId: string): Promise<SessionInfo[]> {
    const sessions = await this.list();
    return sessions.filter((s) => s.projectId === projectId);
  }

  async cleanup(): Promise<{ cleaned: number }> {
    this.log.info("Running cleanup");

    const sessions = await this.loadSessions();
    let cleaned = 0;
    const kept: SessionInfo[] = [];

    for (const session of sessions) {
      const tmuxName = this.getTmuxName(session);
      const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);

      if (session.status === "terminated" || !exists) {
        // Stop terminal if somehow still running
        if (this.ttydPids.has(session.id)) {
          await this.stopTerminal(session.id);
        }

        // Kill the tmux session if it still exists but was marked terminated
        if (exists && session.status === "terminated") {
          tmuxExecSilent(["kill-session", "-t", tmuxName]);
        }

        cleaned++;
        this.log.debug("Cleaned session", {
          id: session.id,
          name: session.name,
        });
      } else {
        kept.push(session);
      }
    }

    await this.saveSessions(kept);

    this.log.info("Cleanup complete", { cleaned, remaining: kept.length });
    return { cleaned };
  }

  // -----------------------------------------------------------------------
  // Core agent interface aliases
  // -----------------------------------------------------------------------

  async get(sessionId: string): Promise<SessionInfo | null> {
    return this.getInfo(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    return this.terminate(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    return this.sendInterrupt(sessionId);
  }

  async capture(sessionId: string): Promise<string> {
    return this.captureOutput(sessionId);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);
    tmuxExecSilent([
      "resize-window",
      "-t",
      tmuxName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
  }

  async listSystem(): Promise<SystemSessionInfo[]> {
    return this.listSystemSessions();
  }

  async killSystem(sessionId: string): Promise<void> {
    tmuxExecSilent(["kill-session", "-t", sessionId]);
  }

  async killSystemTerminal(pid: number): Promise<void> {
    await gracefulKill(pid);
    // Remove from tracked processes if present
    for (const [sessionId, trackedPid] of this.ttydPids) {
      if (trackedPid === pid) {
        this.ttydPids.delete(sessionId);
        this.ttydPorts.delete(sessionId);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Orphan discovery & adoption
  // -----------------------------------------------------------------------

  async discoverOrphans(): Promise<OrphanSessionInfo[]> {
    const known = new Set(
      (await this.loadSessions())
        .filter((s) => s.status !== "terminated")
        .map((s) => this.getTmuxName(s)),
    );
    const sys = await this.listSystemSessions();
    return sys
      .filter((s) => s.name.startsWith("vibe-") && !known.has(s.name))
      .map((s) => ({
        externalName: s.name,
        provider: "tmux",
        windows: s.windows,
        attached: s.attached,
        createdAt: s.createdAt,
      }));
  }

  async adopt(
    externalName: string,
    displayName?: string,
  ): Promise<SessionInfo> {
    const tmuxName = externalName;
    if (!tmuxName.startsWith("vibe-")) {
      throw new Error(
        `Refusing to adopt tmux session "${tmuxName}" — only vibe-* sessions are adoptable`,
      );
    }
    if (!tmuxExecSilent(["has-session", "-t", tmuxName])) {
      throw new Error(`Tmux session "${tmuxName}" does not exist`);
    }

    const id = tmuxName.slice("vibe-".length) || tmuxName;

    // Idempotent: if already tracked, no-op + ensure ttyd is up.
    const existing = (await this.loadSessions()).find((s) => s.id === id);
    if (existing) {
      this.log.info("Adopt: session already tracked", { id, tmuxName });
      if (!this.ttydPids.has(id)) {
        try {
          await this.startTerminal(id);
        } catch (err) {
          this.log.warn("Adopt: failed to start ttyd for tracked session", {
            id,
            error: String(err),
          });
        }
      }
      return (await this.getInfo(id)) ?? existing;
    }

    const now = nowISO();
    const pid = this.getSessionPanePid(tmuxName);
    const info: SessionInfo = {
      id,
      name: displayName || tmuxName,
      status: "active",
      provider: this.name,
      pid: pid ?? undefined,
      createdAt: now,
      updatedAt: now,
      metadata: {
        tmuxSessionName: tmuxName,
        adopted: true,
      },
    };
    await this.saveSession(info);
    this.log.info("Adopted orphan tmux session", { id, tmuxName });

    // Best-effort ttyd spawn so the user can immediately attach.
    try {
      const term = await this.startTerminal(id);
      info.terminal = term;
      await this.saveSession(info);
    } catch (err) {
      this.log.warn("Adopt: ttyd start failed (session still adopted)", {
        id,
        error: String(err),
      });
    }
    return info;
  }

  // -----------------------------------------------------------------------
  // Capability & extended capture methods
  // -----------------------------------------------------------------------

  getCapabilities(): SessionProviderCapabilities {
    return {
      provider: "tmux",
      features: {
        mouse: true,
        resize: true,
        capture: true,
        webTerminal: true,
        splitPanes: true,
        tabs: false,
        scrollback: true,
        clipboard: true,
        search: true,
      },
      platform: ["linux", "macos"],
    };
  }

  async getScrollback(sessionId: string, lines: number): Promise<string> {
    const session = await this.requireSession(sessionId);
    const tmuxName = this.getTmuxName(session);

    this.log.debug("Getting scrollback", { sessionId, lines });
    try {
      const output = tmuxExec([
        "capture-pane",
        "-t",
        tmuxName,
        "-p",
        "-S",
        `-${lines}`,
      ]);
      return output;
    } catch (err) {
      this.log.error("Failed to get scrollback", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to get scrollback for session ${sessionId}: ${err}`,
        {
          cause: err,
        },
      );
    }
  }

  async searchOutput(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>> {
    // Capture a large scrollback buffer and search through it
    const scrollback = await this.getScrollback(sessionId, 10000);
    const lines = scrollback.split("\n");
    const results: Array<{ line: number; content: string }> = [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      // Fall back to literal string match if pattern is not valid regex
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? "")) {
        results.push({ line: i + 1, content: lines[i] ?? "" });
      }
    }

    this.log.debug("Search output completed", {
      sessionId,
      pattern,
      matches: results.length,
    });

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers — storage (TypedStore-backed)
  // -----------------------------------------------------------------------

  private async loadSessions(): Promise<SessionInfo[]> {
    if (!this.sessionsStore) return [];
    const data = await this.sessionsStore.get();
    return data ?? [];
  }

  private async saveSessions(sessions: SessionInfo[]): Promise<void> {
    if (!this.sessionsStore) return;
    try {
      await this.sessionsStore.set(sessions);
    } catch (err) {
      this.log.error("Failed to save sessions to storage", {
        error: String(err),
      });
    }
  }

  private async saveSession(session: SessionInfo): Promise<void> {
    const sessions = await this.loadSessions();
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    await this.saveSessions(sessions);
  }

  // -----------------------------------------------------------------------
  // Private helpers — tmux utilities
  // -----------------------------------------------------------------------

  private getTmuxName(session: SessionInfo): string {
    const meta = session.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.tmuxSessionName === "string") {
      return meta.tmuxSessionName;
    }
    return `vibe-${session.id}`;
  }

  private getSessionPanePid(tmuxName: string): number | null {
    try {
      const raw = tmuxExec(["list-panes", "-t", tmuxName, "-F", "#{pane_pid}"]);
      const pid = parseInt(raw.split("\n")[0] ?? "", 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private async requireSession(sessionId: string): Promise<SessionInfo> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "terminated") {
      throw new Error(`Session is terminated: ${sessionId}`);
    }
    return session;
  }

  /**
   * Get TerminalInfo for a session if ttyd is currently running.
   */
  private getRunningTerminalInfo(sessionId: string): TerminalInfo | null {
    const pid = this.ttydPids.get(sessionId);
    const port = this.ttydPorts.get(sessionId);

    if (!pid || port === undefined) {
      return null;
    }

    // Verify process is still alive (SDK helper)
    if (!isProcessAlive(pid)) {
      this.ttydPids.delete(sessionId);
      this.ttydPorts.delete(sessionId);
      return null;
    }

    return {
      url: `http://localhost:${port}`,
      port,
      pid,
    };
  }

  private async persistTerminals(): Promise<void> {
    if (!this.terminalsStore) return;
    const data: Record<string, PersistedTerminal> = {};
    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (port !== undefined) {
        data[sessionId] = { pid, port };
      }
    }
    try {
      await this.terminalsStore.set(data);
    } catch {
      this.log.warn("Failed to persist terminal state");
    }
  }

  private async loadPersistedTerminals(): Promise<
    Record<string, PersistedTerminal>
  > {
    if (!this.terminalsStore) return {};
    const data = await this.terminalsStore.get();
    return data ?? {};
  }

  /**
   * Reconcile persisted session records against actual tmux state.
   * Recovers ttyd processes from persisted data and adopts orphans.
   */
  private async reconcileSessions(): Promise<void> {
    const sessions = await this.loadSessions();
    const persistedTerminals = await this.loadPersistedTerminals();
    let changed = false;

    for (const session of sessions) {
      if (session.status === "terminated") continue;

      const tmuxName = this.getTmuxName(session);
      const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);

      if (!exists) {
        // Tmux session is gone
        if (session.status === "active") {
          session.status = "inactive";
          session.updatedAt = nowISO();
          session.terminal = undefined;
          changed = true;
          this.log.info("Reconciled: tmux session gone, marking inactive", {
            id: session.id,
          });
        }
        // Kill orphaned ttyd for dead tmux session
        const termData = persistedTerminals[session.id];
        if (termData && isProcessAlive(termData.pid)) {
          this.log.info("Killing orphaned ttyd for dead tmux session", {
            sessionId: session.id,
            pid: termData.pid,
          });
          await gracefulKill(termData.pid);
        }
        delete persistedTerminals[session.id];
        continue;
      }

      // Tmux session exists — try to recover ttyd
      const termData = persistedTerminals[session.id];
      if (termData) {
        if (isProcessAlive(termData.pid)) {
          // ttyd is still alive — re-adopt it
          this.ttydPids.set(session.id, termData.pid);
          this.ttydPorts.set(session.id, termData.port);
          session.terminal = {
            url: `http://localhost:${termData.port}`,
            port: termData.port,
            pid: termData.pid,
          };
          session.status = "active";
          session.updatedAt = nowISO();
          changed = true;
          this.log.info("Recovered ttyd process", {
            sessionId: session.id,
            pid: termData.pid,
            port: termData.port,
          });
        } else {
          // ttyd died — clear stale data
          session.terminal = undefined;
          changed = true;
          delete persistedTerminals[session.id];
          this.log.info("Stale ttyd record cleared (process dead)", {
            sessionId: session.id,
          });
        }
      }

      // Ensure active tmux sessions are marked active
      if (exists && session.status !== "active") {
        session.status = "active";
        session.updatedAt = nowISO();
        changed = true;
      }
    }

    // Phase 2: Scan for orphaned ttyd processes not in persisted data
    try {
      const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      const raw = pgrepResult.stdout.toString().trim();
      if (raw) {
        for (const line of raw.split("\n")) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0] ?? "0", 10);
          if (!pid) continue;

          // Skip already-recovered processes
          if ([...this.ttydPids.values()].includes(pid)) continue;

          // Extract tmux session name from: tmux attach -t <name>
          const tIdx = parts.indexOf("-t");
          const tmuxTarget = tIdx !== -1 ? parts[tIdx + 1] : null;
          if (!tmuxTarget) continue;

          // Match to a known session
          const matchedSession = sessions.find(
            (s) =>
              s.status !== "terminated" && this.getTmuxName(s) === tmuxTarget,
          );
          if (!matchedSession) continue;

          // Extract port from --port <N>
          const portIdx = parts.indexOf("--port");
          const port =
            portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;
          if (!port) continue;

          // Adopt the orphan
          this.ttydPids.set(matchedSession.id, pid);
          this.ttydPorts.set(matchedSession.id, port);
          matchedSession.terminal = {
            url: `http://localhost:${port}`,
            port,
            pid,
          };
          matchedSession.status = "active";
          matchedSession.updatedAt = nowISO();
          changed = true;
          this.log.info("Adopted orphaned ttyd process", {
            sessionId: matchedSession.id,
            pid,
            port,
            tmuxTarget,
          });
        }
      }
    } catch {
      // pgrep not found or no ttyd processes — that's fine
    }

    if (changed) {
      await this.saveSessions(sessions);
    }
    await this.persistTerminals();
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const provider = new TmuxSessionProvider();

// Cross-platform binary discovery via Bun.which (handles PATHEXT on Windows).
function whichSync(bin: string): string | null {
  return Bun.which(bin) ?? null;
}

function createPrereqsRoutes() {
  const checks = ["tmux", "ttyd"];
  const installCmds: Record<string, string> = {
    tmux:
      process.platform === "darwin"
        ? "brew install tmux"
        : "sudo apt-get install -y tmux",
    ttyd:
      process.platform === "darwin"
        ? "brew install ttyd"
        : "sudo apt-get install -y ttyd",
  };

  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const missing = checks
        .filter((bin) => !whichSync(bin))
        .map((name) => ({
          name,
          kind: "binary" as const,
          requiresSudo: true,
        }));
      return { satisfied: missing.length === 0, missing };
    })
    .post("/install", () => {
      const pendingSudo = checks
        .filter((bin) => !whichSync(bin))
        .map((name) => ({
          name,
          command: installCmds[name] ?? `(see install docs for ${name})`,
          reason: `${name} is required for tmux session backend.`,
        }));
      return {
        ok: true,
        installed: [],
        pendingSudo,
        errors: [],
      };
    })
    .post("/uninstall", () => ({ ok: true }));
}

// Lifecycle hooks via SDK — auto-emits `<plugin>.ready` telemetry,
// skips init on Windows (tmux is POSIX-only), delegates to provider.
const lifecycle = createLifecycleHooks({
  name: PLUGIN_NAME,
  skipPlatforms: ["win32"],
  telemetryEventName: `${PLUGIN_NAME}.ready`,
  onInit: async (services) => {
    // Provider registration via SDK — graceful no-op when registry absent.
    new ProviderRegistry(services).registerProvider(
      "session",
      PROVIDER_NAME,
      provider,
    );
    // Plugin-specific ready emit (preserves prior `session.provider.ready` event).
    new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, services).emit(
      "session.provider.ready",
      { provider: "tmux" },
    );
    await provider.init(services);
  },
  onShutdown: async () => {
    await provider.shutdown({ reason: "shutdown" });
  },
});

const vibePlugin: VibePlugin = {
  capabilities: {
    storage: "rw",
    subprocess: true,
    telemetry: true,
  },
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Tmux + ttyd session provider — manages terminal sessions via tmux and exposes web terminals via ttyd",
  tags: ["backend", "provider"],
  apiPrefix: "/api/session-tmux",

  prerequisites: [
    {
      name: "tmux",
      kind: "binary",
      requiresSudo: true,
    },
    {
      name: "ttyd",
      kind: "binary",
      requiresSudo: true,
    },
  ],

  createRoutes: () => createPrereqsRoutes(),
  onServerStart: lifecycle.onServerStart,
  onServerStop: lifecycle.onServerStop,
};

export { vibePlugin };
export type {
  SessionProvider,
  SessionProviderCapabilities,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
};

/**
 * @burdenoff/vibe-plugin-session-tmux
 *
 * Tmux + ttyd session provider plugin for VibeControls Agent.
 * Implements the full SessionProvider interface (23 methods) using tmux for
 * terminal session management and ttyd for browser-accessible web terminals.
 */

import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus = "active" | "inactive" | "terminated" | "error";

interface SessionConfig {
  name: string;
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  shell?: string;
  size?: { cols: number; rows: number };
  projectId?: string;
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
}

// ---------------------------------------------------------------------------
// HostServices — provided by the vibe-agent runtime at plugin load
// ---------------------------------------------------------------------------

interface HostLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

interface HostStorage {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
}

interface HostServices {
  logger: HostLogger;
  storage: HostStorage;
}

// ---------------------------------------------------------------------------
// VibePlugin interface
// ---------------------------------------------------------------------------

interface VibePlugin {
  name: string;
  version: string;
  description: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  providers: {
    session?: SessionProvider;
  };
  onServerStart?(services: HostServices): Promise<void>;
  onServerStop?(): Promise<void>;
  onCliSetup?(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "session-tmux";
const STORAGE_NAMESPACE = "session-tmux";
const STORAGE_KEY_SESSIONS = "sessions";
const TTYD_BASE_PORT = 7681;
const TTYD_PORT_RANGE = 200;
const GRACEFUL_KILL_TIMEOUT_MS = 3000;

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
 * Find an available TCP port starting from `start` within the configured range.
 */
async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + TTYD_PORT_RANGE; port++) {
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  throw new Error(
    `No available port found in range ${start}-${start + TTYD_PORT_RANGE - 1}`,
  );
}

/**
 * Check whether a TCP port is available by attempting to bind to it.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
        },
      });
      server.stop(true);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Send SIGTERM to a process, then SIGKILL after timeout if still alive.
 */
async function gracefulKill(
  pid: number,
  timeout: number = GRACEFUL_KILL_TIMEOUT_MS,
): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already dead — nothing to do
    return;
  }

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await sleep(200);
    if (!isProcessAlive(pid)) {
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone
  }
}

/**
 * Check if a process is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simple async sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class TmuxSessionProvider implements SessionProvider {
  readonly name = PROVIDER_NAME;

  private services: HostServices | null = null;

  /** Logger with safe no-op fallback until init() is called. */
  private log: HostLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  /** Storage with safe in-memory fallback until init() is called. */
  private storage: HostStorage = (() => {
    const mem = new Map<string, string>();
    return {
      get: async (namespace: string, key: string) =>
        mem.get(`${namespace}:${key}`) ?? null,
      set: async (namespace: string, key: string, value: string) => {
        mem.set(`${namespace}:${key}`, value);
      },
      delete: async (namespace: string, key: string) => {
        return mem.delete(`${namespace}:${key}`);
      },
    };
  })();

  /** In-memory map of ttyd child processes keyed by session ID. */
  private ttydProcesses: Map<string, Subprocess> = new Map();

  /** In-memory map of ttyd port assignments keyed by session ID. */
  private ttydPorts: Map<string, number> = new Map();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the provider with host services. Called from onServerStart.
   */
  async init(services: HostServices): Promise<void> {
    this.services = services;
    if (services.logger) this.log = services.logger;
    if (services.storage) this.storage = services.storage;

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
  async shutdown(): Promise<void> {
    this.log.info("TmuxSessionProvider shutting down — stopping terminals");

    const stopPromises: Promise<void>[] = [];
    for (const [sessionId] of this.ttydProcesses) {
      stopPromises.push(this.stopTerminal(sessionId));
    }
    await Promise.allSettled(stopPromises);

    this.log.info("TmuxSessionProvider shutdown complete");
  }

  // -----------------------------------------------------------------------
  // SessionProvider — create / terminate / getInfo / list
  // -----------------------------------------------------------------------

  async create(config: SessionConfig): Promise<SessionInfo> {
    const id = generateId();
    const sessionName = `vibe-${id}`;
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
    if (this.ttydProcesses.has(sessionId)) {
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

    // Find available port
    const assignedPort = port ?? (await findAvailablePort(TTYD_BASE_PORT));

    this.log.info("Starting ttyd terminal", {
      sessionId,
      tmuxName,
      port: assignedPort,
    });

    // Spawn ttyd process
    const child = Bun.spawn(
      [
        "ttyd",
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
      },
    );

    if (!child.pid) {
      throw new Error("Failed to start ttyd — no PID returned");
    }

    // Give ttyd a moment to bind the port
    await sleep(500);

    // Store references
    this.ttydProcesses.set(sessionId, child);
    this.ttydPorts.set(sessionId, assignedPort);

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
    const child = this.ttydProcesses.get(sessionId);
    if (!child) {
      this.log.debug("No ttyd process found for session", { sessionId });
      return;
    }

    this.log.info("Stopping ttyd terminal", {
      sessionId,
      pid: child.pid,
    });

    if (child.pid) {
      await gracefulKill(child.pid);
    }

    this.ttydProcesses.delete(sessionId);
    this.ttydPorts.delete(sessionId);

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

    for (const [sessionId, child] of this.ttydProcesses) {
      const port = this.ttydPorts.get(sessionId);
      if (child.pid && port !== undefined) {
        terminals.push({
          pid: child.pid,
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
          const alreadyTracked = [...this.ttydProcesses.values()].some(
            (p) => p.pid === pid,
          );
          if (alreadyTracked) continue;

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
        for (const [sessionId, child] of this.ttydProcesses) {
          if (child.pid === pid) {
            this.ttydProcesses.delete(sessionId);
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
    const terminalCount = this.ttydProcesses.size;

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
    let ttydOk = false;
    try {
      const whichResult = Bun.spawnSync(["which", "ttyd"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      ttydOk = whichResult.exitCode === 0;
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
        if (this.ttydProcesses.has(session.id)) {
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
  // The core SessionProvider interface uses these names; delegate to our
  // implementations so the session routes work correctly.
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
    for (const [sessionId, child] of this.ttydProcesses) {
      if (child.pid === pid) {
        this.ttydProcesses.delete(sessionId);
        this.ttydPorts.delete(sessionId);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers — storage
  // -----------------------------------------------------------------------

  /**
   * Load all session records from persistent storage.
   */
  private async loadSessions(): Promise<SessionInfo[]> {
    try {
      const raw = await this.storage.get(
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
      );
      if (!raw) return [];
      return JSON.parse(raw) as SessionInfo[];
    } catch (err) {
      this.log.error("Failed to load sessions from storage", {
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Save the full session list to persistent storage.
   */
  private async saveSessions(sessions: SessionInfo[]): Promise<void> {
    try {
      await this.storage.set(
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
        JSON.stringify(sessions),
      );
    } catch (err) {
      this.log.error("Failed to save sessions to storage", {
        error: String(err),
      });
    }
  }

  /**
   * Save (upsert) a single session record.
   */
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

  /**
   * Extract the tmux session name from a SessionInfo record.
   * The tmux session name is stored in metadata.tmuxSessionName or
   * defaults to `vibe-{id}`.
   */
  private getTmuxName(session: SessionInfo): string {
    const meta = session.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.tmuxSessionName === "string") {
      return meta.tmuxSessionName;
    }
    return `vibe-${session.id}`;
  }

  /**
   * Get the PID of the first pane in a tmux session.
   */
  private getSessionPanePid(tmuxName: string): number | null {
    try {
      const raw = tmuxExec(["list-panes", "-t", tmuxName, "-F", "#{pane_pid}"]);
      const pid = parseInt(raw.split("\n")[0] ?? "", 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Look up a session by ID and throw if not found.
   */
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
    const child = this.ttydProcesses.get(sessionId);
    const port = this.ttydPorts.get(sessionId);

    if (!child || !child.pid || port === undefined) {
      return null;
    }

    // Verify process is still alive
    if (!isProcessAlive(child.pid)) {
      this.ttydProcesses.delete(sessionId);
      this.ttydPorts.delete(sessionId);
      return null;
    }

    return {
      url: `http://localhost:${port}`,
      port,
      pid: child.pid,
    };
  }

  /**
   * Reconcile persisted session records against actual tmux state.
   * Marks sessions as inactive/terminated if their tmux session is gone.
   */
  private async reconcileSessions(): Promise<void> {
    const sessions = await this.loadSessions();
    let changed = false;

    for (const session of sessions) {
      if (session.status === "terminated") continue;

      const tmuxName = this.getTmuxName(session);
      const exists = tmuxExecSilent(["has-session", "-t", tmuxName]);

      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
        session.terminal = undefined;
        changed = true;
        this.log.info("Reconciled stale session as inactive", {
          id: session.id,
          name: session.name,
        });
      }
    }

    if (changed) {
      await this.saveSessions(sessions);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const provider = new TmuxSessionProvider();

const vibePlugin: VibePlugin = {
  name: "@burdenoff/vibe-plugin-session-tmux",
  version: "2.3.0",
  description:
    "Tmux + ttyd session provider — manages terminal sessions via tmux and exposes web terminals via ttyd",
  tags: ["backend", "provider"],

  providers: {
    session: provider,
  },

  async onServerStart(services: HostServices): Promise<void> {
    await provider.init(services);
  },

  async onServerStop(): Promise<void> {
    await provider.shutdown();
  },
};

export { vibePlugin };
export type {
  SessionProvider,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
  VibePlugin,
  HostServices,
};

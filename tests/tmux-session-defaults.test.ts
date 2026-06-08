import { describe, expect, it } from "bun:test";

import { applyTmuxSessionDefaults } from "../src/index";

/**
 * Regression coverage for the browser-terminal mouse fix.
 *
 * Sessions used to be created with `mouse on`, which routed every drag in the
 * ttyd/xterm.js web terminal into tmux copy-mode ("SCROLL MODE — press Esc or
 * q") instead of letting the browser do a native click-drag selection +
 * copy/paste. `applyTmuxSessionDefaults` now sets `mouse off` so the web
 * terminal behaves like a real terminal (iTerm2-style). These tests lock that
 * in at the command level (no tmux required) and, when a real tmux is present,
 * assert the option actually lands as `off`.
 */
describe("applyTmuxSessionDefaults", () => {
  it("disables tmux mouse mode so the browser owns selection", () => {
    const calls: string[][] = [];
    applyTmuxSessionDefaults("vibe-deadbeef", (args) => {
      calls.push(args);
      return true;
    });

    // The decisive command for the bug: mouse must be turned OFF.
    expect(calls).toContainEqual([
      "set",
      "-t",
      "vibe-deadbeef",
      "mouse",
      "off",
    ]);
    // It must never re-enable mouse mode as a default.
    expect(calls).not.toContainEqual([
      "set",
      "-t",
      "vibe-deadbeef",
      "mouse",
      "on",
    ]);
  });

  it("keeps the mouse-on copy ergonomics wired up (clipboard + drag-end bind)", () => {
    const calls: string[][] = [];
    applyTmuxSessionDefaults("vibe-deadbeef", (args) => {
      calls.push(args);
      return true;
    });

    // OSC-52 clipboard bridge stays on so a copy (when a user toggles mouse
    // back on, or an app copies) reaches the browser clipboard through ttyd.
    expect(calls).toContainEqual([
      "set",
      "-t",
      "vibe-deadbeef",
      "set-clipboard",
      "on",
    ]);
    // Drag-end in copy-mode copies and exits, so a toggled-on mouse selection
    // doesn't leave the pane stuck in copy-mode.
    const hasDragEndCopy = calls.some(
      (a) =>
        a[0] === "bind-key" &&
        a.includes("MouseDragEnd1Pane") &&
        a.includes("copy-pipe-and-cancel"),
    );
    expect(hasDragEndCopy).toBe(true);
  });

  it("scopes every option to the target session (never global)", () => {
    const calls: string[][] = [];
    applyTmuxSessionDefaults("vibe-deadbeef", (args) => {
      calls.push(args);
      return true;
    });

    for (const args of calls) {
      if (args[0] === "set" || args[0] === "set-hook") {
        // session-scoped `-t <name>`, never `-g` (which would leak onto every
        // other session sharing the tmux server).
        expect(args).toContain("-t");
        expect(args).not.toContain("-g");
      }
    }
  });

  // Integration assertion against a real tmux. Skips automatically on hosts
  // without tmux (e.g. the ubuntu-latest CI runner), so it never makes CI red.
  const tmuxAvailable =
    Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0;

  it.skipIf(!tmuxAvailable)(
    "results in `mouse off` on a live tmux session",
    () => {
      const session = `vibetest${process.pid}`;
      // Dedicated socket NAME (not a path) so `-L` keeps us off a developer's
      // real tmux server.
      const sock = `vibetestsock${process.pid}`;
      const t = (args: string[]) =>
        Bun.spawnSync(["tmux", "-L", sock, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
      try {
        t(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
        applyTmuxSessionDefaults(session, (args) => t(args).exitCode === 0);
        const mouse = t(["show-options", "-t", session, "-v", "mouse"])
          .stdout.toString()
          .trim();
        expect(mouse).toBe("off");
      } finally {
        t(["kill-server"]);
      }
    },
  );
});

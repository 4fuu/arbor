/**
 * A thin wrapper over the `ovnfs` binary (docs/workspaces.md).
 *
 * Every operation is one `ovnfs ctl OP 'JSON'` call, which sends the admin
 * request and prints the raw reply as JSON on stdout. A reply is parsed whether
 * or not the process exits zero: `apply` reports conflicts in its reply, and a
 * daemon error answers with a non-zero exit and empty stdout. The daemon is
 * started once, by `start`, before anything else is asked of it.
 *
 * The binary is pinned at v0.1.1; `version` reads what is installed so the host
 * can warn on a mismatch without failing.
 */

import { execFile } from "node:child_process";

/** How much one reply may hold before the wrapper refuses it. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** The running daemon, from `ovnfs --json start`. */
export interface OvnfsStatus {
  version: number;
  pid: number;
  proto: string;
  port: number;
  mount: string;
  state: string;
  socket: string;
  checkouts: number;
}

/** One checkout, as `ovnfs ctl ls` lists it. */
export interface OvnfsCheckoutInfo {
  name: string;
  path: string;
  source: string;
  base: string;
  git: boolean;
  dirty: boolean;
}

/** `ovnfs ctl ls` reply. */
export interface OvnfsLsReply {
  checkouts: OvnfsCheckoutInfo[];
  snapshots: { id: string; checkout: string }[];
}

/** `ovnfs ctl new` arguments. */
export interface OvnfsNewArgs {
  dir?: string;
  name?: string;
}

/** `ovnfs ctl new` reply. */
export interface OvnfsNewReply {
  checkout: OvnfsCheckoutInfo;
  warnings: string[];
}

/** One changed path, as `diff` and `apply` report it. */
export interface OvnfsChange {
  path: string;
  status: string;
}

/** `ovnfs ctl diff` reply. */
export interface OvnfsDiffReply {
  from: string;
  changes: OvnfsChange[];
  patch?: string;
}

/** `ovnfs ctl apply` arguments. */
export interface OvnfsApplyArgs {
  checkout: string;
  branch?: string;
  dry_run?: boolean;
}

/** One path apply could not settle. */
export interface OvnfsConflict {
  path: string;
  reason: string;
  markers: boolean;
}

/** `ovnfs ctl apply` reply. */
export interface OvnfsApplyReply {
  snapshot: { id: string; checkout: string };
  source: string;
  applied: OvnfsChange[];
  merged: string[];
  conflicts: OvnfsConflict[];
  branch?: string;
  commit?: string;
}

export class OvnfsCli {
  private readonly bin: string;
  private readonly state: string;
  private readonly mount: string;

  constructor(bin: string, state: string, mount: string) {
    this.bin = bin;
    this.state = state;
    this.mount = mount;
  }

  /** The build this binary reports, for the pinned-version check. */
  version(): Promise<string> {
    return this.text(["version"]);
  }

  /** Make sure the daemon runs and answer its status. */
  start(): Promise<OvnfsStatus> {
    return this.json<OvnfsStatus>(["--json", "start"]);
  }

  /** Every live checkout, with its dirty flag. */
  ls(): Promise<OvnfsLsReply> {
    return this.json<OvnfsLsReply>(["ctl", "ls", "{}"]);
  }

  /** Open a checkout on a folder. */
  open(args: OvnfsNewArgs): Promise<OvnfsNewReply> {
    return this.json<OvnfsNewReply>(["ctl", "new", JSON.stringify(args)]);
  }

  /** A checkout's changed source paths since its base. */
  diff(checkout: string): Promise<OvnfsDiffReply> {
    return this.json<OvnfsDiffReply>(["ctl", "diff", JSON.stringify({ checkout })]);
  }

  /** Merge a checkout's changes back into its folder. */
  apply(args: OvnfsApplyArgs): Promise<OvnfsApplyReply> {
    return this.json<OvnfsApplyReply>(["ctl", "apply", JSON.stringify(args)]);
  }

  /** Remove a checkout; its snapshots stay. */
  rm(checkout: string): Promise<void> {
    return this.json<unknown>(["ctl", "rm", JSON.stringify({ checkout })]).then(() => undefined);
  }

  private global(args: readonly string[]): string[] {
    return ["--state", this.state, "--mount", this.mount, ...args];
  }

  private text(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, this.global(args), { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * One operation that answers with JSON. A reply is read from stdout whether
   * or not the process exited zero, because `ctl` prints the reply and reports
   * a daemon error on stderr with a non-zero exit and no stdout.
   */
  private json<T>(args: readonly string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, this.global(args), { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        const body = stdout.trim();
        if (body === "") {
          reject(new Error((stderr || error?.message || "ovnfs: no reply").trim()));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          reject(new Error(`ovnfs: reply was not JSON: ${body.slice(0, 200)}`));
        }
      });
    });
  }
}

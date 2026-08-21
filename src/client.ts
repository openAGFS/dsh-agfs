/**
 * Client half of the dual-face plugin: registers one slash-command source on
 * the composer's input-trigger service so picking `/files` from the menu
 * opens the file browser in a new tab **in the user's browser**, deep-linked
 * to the current session's workspace directory.
 *
 * Why: the host-side `/dsh-agfs` command opens the system default browser on
 * the machine dsh runs on. That works for local desktop use and cannot work
 * on a headless host — the dominant remote-deployment shape, where the
 * browser that should open the app sits on the user's own machine, not the
 * server. This half closes the gap: the trigger runs where the browser is.
 *
 * Shape notes (mirrors @deepseek-ai/dsh-client-ui-skill's source):
 * - candidate `name` carries no slash and stays distinct from the host
 *   command (`/dsh-agfs` is already listed by the commands source, so a
 *   same-named candidate would double the menu entry);
 * - the pick outcome replaces the token span in the draft, so a successful
 *   open clears `/files` and nothing is sent to the model;
 * - `window.location.origin` builds the URL: whichever origin served the GUI
 *   (public domain, LAN address, loopback) is the right one to open;
 * - a popup-blocked pick falls back to leaving the URL as draft text so the
 *   user still has something to copy.
 *
 * The half declares its own minimal structural faces instead of importing
 * SDK client types: pulling the client packages' declaration merges into the
 * program would change `Context` typing for the whole repo (the node half's
 * tests typecheck against the server sessions service). Zero type imports
 * keep the dual halves' type environments independent.
 *
 * @module @open-agfs/dsh-agfs/client
 */

/** Services this half consumes: the session store (for the cwd) and the trigger pipeline. */
export const inject = ['sessions', 'inputTriggers']

/**
 * The browser globals this half touches, declared locally: the package's
 * tsconfig carries no DOM lib (the node half must stay DOM-free), so the
 * classic-script environment is described here instead of pulling `lib.dom`.
 */
declare const window: {
  location: { origin: string }
  open(url?: string, target?: string, features?: string): unknown
}

/** One menu candidate as the trigger pipeline renders it. */
interface Candidate {
  name: string
  description: string
}

/** The pick outcome this half returns: replace the token span with text. */
interface TextOutcome {
  text: string
}

/** The minimal input-trigger face this half needs: source registration. */
interface InputTriggersFace {
  registerSource(source: {
    trigger: '/'
    name: string
    order: number
    candidates(): Promise<Candidate[]>
    onPick(): TextOutcome
  }): () => void
}

/** The minimal sessions face this half needs: the list store snapshot. */
interface SessionsFace {
  list: {
    getSnapshot(): { current?: string; byId?: Record<string, { cwd?: string }> } | undefined
  }
}

/** The apply-time context face: service resolution plus effect scoping. */
interface ClientContextFace {
  get(service: 'sessions'): SessionsFace
  get(service: 'inputTriggers'): InputTriggersFace
  effect(register: () => () => void, tag: string): void
}

/** Resolve the current session's workspace directory from the sessions store. */
export function currentCwd(sessions: SessionsFace): string | undefined {
  try {
    const snapshot = sessions.list.getSnapshot()
    const current = snapshot?.current
    if (current === undefined) return undefined
    return snapshot?.byId?.[current]?.cwd
  } catch {
    return undefined
  }
}

/** Build the file-browser URL against the serving origin; `?path=` carries the cwd. */
export function appUrl(cwd: string | undefined): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const base = `${origin}/dsh-agfs/`
  return cwd !== undefined && cwd !== '' ? `${base}?path=${encodeURIComponent(cwd)}` : base
}

/** Open the URL in a new tab. Returns false when the popup blocker swallowed it. */
export function openTab(url: string): boolean {
  try {
    const win = window.open(url, '_blank', 'noopener')
    return win !== null && win !== undefined
  } catch {
    return false
  }
}

/** Register the `/files` menu candidate that opens the app client-side. */
export function apply(ctx: ClientContextFace): void {
  const sessions = ctx.get('sessions')
  const inputTriggers = ctx.get('inputTriggers')

  const source = {
    trigger: '/' as const,
    name: 'dsh-agfs',
    order: 900,
    candidates() {
      return Promise.resolve([
        {
          name: 'files',
          description: '在新标签页打开文件浏览器（定位到当前会话目录）',
        },
      ])
    },
    onPick() {
      const url = appUrl(currentCwd(sessions))
      // Success clears the token span (nothing is sent to the model); a
      // blocked popup falls back to leaving the URL in the draft to copy.
      return openTab(url) ? { text: '' } : { text: url }
    },
  }

  ctx.effect(() => inputTriggers.registerSource(source), 'dsh-agfs: /files client trigger')
}

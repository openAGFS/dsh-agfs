/**
 * System openers for the file browser: default browser, default application,
 * and file-manager reveal. Pure command builders plus thin spawn wrappers, so
 * tests can pin the exact command lines without spawning anything.
 * @module @open-agfs/dsh-agfs/open
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'

/** One spawnable command: executable plus argument vector. */
export interface SpawnCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** Build the system default-browser open command for one URL. */
export function browserCommand(platformName: string, url: string): SpawnCommand {
  if (platformName === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  if (platformName === 'darwin') return { command: 'open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

/** Build the system default-application open command for one path. */
export function openCommand(platformName: string, target: string): SpawnCommand {
  if (platformName === 'win32') return { command: 'cmd', args: ['/c', 'start', '', target] }
  if (platformName === 'darwin') return { command: 'open', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

/** Build the file-manager reveal command for one path. */
export function explorerCommand(platformName: string, target: string, isFile: boolean): SpawnCommand {
  if (platformName === 'win32') {
    if (isFile) return { command: 'explorer', args: ['/select,', target] }
    return { command: 'cmd', args: ['/c', 'start', '', target] }
  }
  if (platformName === 'darwin') return { command: 'open', args: ['-R', target] }
  return { command: 'xdg-open', args: [isFile ? target.slice(0, target.lastIndexOf('/')) : target] }
}

/** Spawn one command with stdio ignored; resolves on spawn, rejects on spawn error. */
function run(command: SpawnCommand): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.command, [...command.args], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { resolvePromise() })
  })
}

/** Open a URL in the system default browser. */
export function openInBrowser(url: string): Promise<void> {
  return run(browserCommand(process.platform, url))
}

/** Open a file or folder with the system default application. */
export function openInSystem(target: string): Promise<void> {
  return run(openCommand(process.platform, target))
}

/** Reveal a file or folder in the system file manager. */
export function openLocationInExplorer(target: string): Promise<void> {
  return run(explorerCommand(process.platform, target, statIsFile(target)))
}

/** Whether a path names a regular file (the explorer reveal differs by type). */
function statIsFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

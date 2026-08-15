/**
 * Unit coverage for the system openers: pure command builders across the three
 * platform families, plus the spawn wrappers with `node:child_process` mocked
 * so no test actually launches a browser, explorer, or default application.
 * Wrapper assertions derive the expected command from the builders so the
 * suite replays identically on Windows, macOS, and Linux.
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserCommand,
  explorerCommand,
  openCommand,
  openInBrowser,
  openInSystem,
  openLocationInExplorer,
} from '../src/open.ts'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** A fake ChildProcess that only emits the lifecycle events the wrapper awaits. */
function fakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess
}

let root: string | undefined

afterEach(async () => {
  spawnMock.mockReset()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command builders', () => {
  it('builds browser commands per platform', () => {
    expect(browserCommand('win32', 'http://x/')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'http://x/'] })
    expect(browserCommand('darwin', 'http://x/')).toEqual({ command: 'open', args: ['http://x/'] })
    expect(browserCommand('linux', 'http://x/')).toEqual({ command: 'xdg-open', args: ['http://x/'] })
  })

  it('builds default-application open commands per platform', () => {
    expect(openCommand('win32', 'C:\\f.txt')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'C:\\f.txt'] })
    expect(openCommand('darwin', '/f.txt')).toEqual({ command: 'open', args: ['/f.txt'] })
    expect(openCommand('linux', '/f.txt')).toEqual({ command: 'xdg-open', args: ['/f.txt'] })
  })

  it('builds file-manager reveal commands per platform and target kind', () => {
    expect(explorerCommand('win32', 'C:\\f.txt', true)).toEqual({ command: 'explorer', args: ['/select,', 'C:\\f.txt'] })
    expect(explorerCommand('win32', 'C:\\dir', false)).toEqual({ command: 'explorer', args: ['C:\\dir'] })
    expect(explorerCommand('darwin', '/f.txt', true)).toEqual({ command: 'open', args: ['-R', '/f.txt'] })
    expect(explorerCommand('linux', '/a/b/f.txt', true)).toEqual({ command: 'xdg-open', args: ['/a/b'] })
    expect(explorerCommand('linux', '/a/b', false)).toEqual({ command: 'xdg-open', args: ['/a/b'] })
  })
})

describe('spawn wrappers', () => {
  it('resolves on spawn for a browser open', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const opened = openInBrowser('http://x/')
    const expected = browserCommand(process.platform, 'http://x/')
    expect(spawnMock).toHaveBeenCalledWith(expected.command, expected.args, { stdio: 'ignore', windowsHide: false })
    child.emit('spawn')
    await expect(opened).resolves.toBeUndefined()
  })

  it('rejects when the spawned process fails to start', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const opened = openInBrowser('http://x/')
    child.emit('error', new Error('ENOENT'))
    await expect(opened).rejects.toThrow('ENOENT')
  })

  it('opens a file with the default application', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const opened = openInSystem('C:\\f.txt')
    const expected = openCommand(process.platform, 'C:\\f.txt')
    expect(spawnMock).toHaveBeenCalledWith(expected.command, expected.args, { stdio: 'ignore', windowsHide: false })
    child.emit('spawn')
    await expect(opened).resolves.toBeUndefined()
  })

  it('reveals a file and a folder in the file manager', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-agfs-open-'))
    await writeFile(join(root, 'f.txt'), 'x')
    await mkdir(join(root, 'dir'))
    const fileChild = fakeChild()
    spawnMock.mockReturnValueOnce(fileChild)
    const revealFile = openLocationInExplorer(join(root, 'f.txt'))
    const fileExpected = explorerCommand(process.platform, join(root, 'f.txt'), true)
    expect(spawnMock).toHaveBeenLastCalledWith(fileExpected.command, fileExpected.args, { stdio: 'ignore', windowsHide: false })
    fileChild.emit('spawn')
    await revealFile
    const dirChild = fakeChild()
    spawnMock.mockReturnValueOnce(dirChild)
    const revealDir = openLocationInExplorer(join(root, 'dir'))
    const dirExpected = explorerCommand(process.platform, join(root, 'dir'), false)
    expect(spawnMock).toHaveBeenLastCalledWith(dirExpected.command, dirExpected.args, { stdio: 'ignore', windowsHide: false })
    dirChild.emit('spawn')
    await revealDir
  })

  it('treats a missing reveal target as a folder', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const target = join(tmpdir(), 'dsh-agfs-missing-xyz')
    const revealed = openLocationInExplorer(target)
    const expected = explorerCommand(process.platform, target, false)
    expect(spawnMock).toHaveBeenLastCalledWith(expected.command, expected.args, { stdio: 'ignore', windowsHide: false })
    child.emit('spawn')
    await expect(revealed).resolves.toBeUndefined()
  })
})

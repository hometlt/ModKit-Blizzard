import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const frame = value => {
  const json = JSON.stringify(value)
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
}

test('packaged Galaxy LSP completes an initialize/shutdown stdio exchange', async t => {
  const child = spawn(
    process.execPath,
    [resolve('starcraft2/dist/modules/galaxy/language/lsp-cli.js'), '--stdio'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  let output = ''
  let errorOutput = ''
  let shutdownSent = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { errorOutput += chunk })
  child.stdout.on('data', chunk => {
    output += chunk
    if (!shutdownSent && output.includes('"capabilities"')) {
      shutdownSent = true
      child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }))
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }))
      child.stdin.end()
    }
  })
  child.stdin.write(frame({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: null, capabilities: {}, rootUri: null },
  }))
  const exitCode = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Galaxy LSP smoke timed out')), 10_000)
      timer.unref()
    }),
  ])
  assert.equal(exitCode, 0, errorOutput)
  assert.match(output, /"textDocumentSync"/u)
  assert.match(output, /"completionProvider"/u)
  assert.match(output, /"renameProvider"/u)
})

test('packaged Galaxy LSP resolves a symbol from an indexed workspace file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-galaxy-lsp-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const definitionPath = join(directory, 'definitions.galaxy')
  const usePath = join(directory, 'use.galaxy')
  await writeFile(definitionPath, 'int SharedValue = 1;\n')
  await writeFile(usePath, 'void Test() { SharedValue = 2; }\n')

  const child = spawn(
    process.execPath,
    [resolve('starcraft2/dist/modules/galaxy/language/lsp-cli.js'), '--stdio'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  let output = ''
  let errorOutput = ''
  let definitionSent = false
  let shutdownSent = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { errorOutput += chunk })
  child.stdout.on('data', chunk => {
    output += chunk
    if (!definitionSent && output.includes('"id":1')) {
      definitionSent = true
      child.stdin.write(frame({
        jsonrpc: '2.0',
        id: 3,
        method: 'textDocument/definition',
        params: {
          textDocument: { uri: pathToFileURL(usePath).href },
          position: { line: 0, character: 16 },
        },
      }))
    }
    if (!shutdownSent && output.includes('"id":3')) {
      shutdownSent = true
      child.stdin.write(frame({ jsonrpc: '2.0', id: 4, method: 'shutdown' }))
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }))
      child.stdin.end()
    }
  })
  child.stdin.write(frame({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: null,
      capabilities: { workspace: { workspaceFolders: true } },
      rootUri: pathToFileURL(directory).href,
      workspaceFolders: [{ uri: pathToFileURL(directory).href, name: 'fixture' }],
    },
  }))
  const exitCode = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Galaxy workspace LSP smoke timed out')), 10_000)
      timer.unref()
    }),
  ])
  assert.equal(exitCode, 0, errorOutput)
  assert.match(output, /"id":3/u)
  assert.match(output, /definitions\.galaxy/u)
})

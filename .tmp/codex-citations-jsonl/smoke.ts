import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { CitationVisibilityResponse, MeasurementPlanV2 } from '../../packages/contracts/src/index.ts'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const cli = path.join(repository, 'packages', 'canonry', 'bin', 'canonry.mjs')
const prefix = 'canonry-citations-built-smoke-'
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const databasePath = path.join(temporaryDirectory, 'data.db')
const token = `cnry_${crypto.randomBytes(24).toString('hex')}`
const now = '2026-11-08T00:00:00.000Z'
const providers = ['gemini', 'claude']
const isolatedSettings = {
  CANONRY_CONFIG_DIR: temporaryDirectory,
  CANONRY_BASE_PATH: '',
  CANONRY_PORT: '',
  CANONRY_TRACE: '',
  CANONRY_TELEMETRY_DISABLED: '1',
  CANONRY_DISABLE_UPDATE_CHECK: '1',
  CANONRY_NO_AUTO_SKILLS_SYNC: '1',
  CANONRY_STORED_ONLY: '1',
  CANONRY_AGENT_DISABLED: '1',
  DO_NOT_TRACK: '1',
} as const
const previousSettings = new Map(Object.keys(isolatedSettings).map(key => [key, process.env[key]]))
Object.assign(process.env, isolatedSettings)

// Stored-only gates child CLI requests; draft setup uses direct public HTTP.
const childEnvironment: NodeJS.ProcessEnv = { ...isolatedSettings, TEMP: temporaryDirectory, TMP: temporaryDirectory, TZ: 'UTC' }
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key] !== undefined) childEnvironment[key] = process.env[key]
}

let closeApp = async (): Promise<void> => {}
let closeDatabase = (): void => {}
try {
const apiRequire = createRequire(new URL('../../packages/api-routes/package.json', import.meta.url))
const [{ default: Fastify }, database, contracts, { apiRoutes }, { buildMeasurementPlanV2Manifest }] = await Promise.all([
  import(pathToFileURL(apiRequire.resolve('fastify')).href),
  import('../../packages/db/src/index.ts'),
  import('../../packages/contracts/src/index.ts'),
  import('../../packages/api-routes/src/index.ts'),
  import('../../packages/api-routes/src/measurement-report-adapter.ts'),
])
const db = database.createClient(databasePath)
const app = Fastify({ logger: false })
closeApp = () => app.close()
closeDatabase = () => db.$client.close()
const requests: Array<{ method: string; url: string }> = []
app.addHook('onRequest', async request => {
  requests.push({ method: request.method, url: request.url })
})

interface SmokeCase {
  name: string
  mode: 'Simple' | 'Advanced'
  state: 'ready' | 'no-runs' | 'no-queries'
  projectId: string
  queryIds: string[]
  plan?: MeasurementPlanV2
  planVersionId?: string
}

function seedProject(name: string, mode: SmokeCase['mode'], state: SmokeCase['state']): SmokeCase {
  const projectId = crypto.randomUUID()
  db.insert(database.projects).values({
    id: projectId, name, displayName: 'Example', canonicalDomain: 'example.com',
    aliases: ['Example'], country: 'US', language: 'en', providers,
    createdAt: now, updatedAt: now,
  }).run()
  db.insert(database.competitors).values({
    id: crypto.randomUUID(), projectId, domain: 'rival.com', createdAt: now,
  }).run()
  const queryIds: string[] = []
  if (state !== 'no-queries') {
    for (const query of ['best local services', 'Example Main reviews']) {
      const id = crypto.randomUUID()
      queryIds.push(id)
      db.insert(database.queries).values({ id, projectId, query, createdAt: now }).run()
    }
  }
  return { name, mode, state, projectId, queryIds }
}

function seedRun(entry: SmokeCase): void {
  assert.equal(entry.queryIds.length, 2)
  const runId = crypto.randomUUID()
  db.insert(database.runs).values({
    id: runId, projectId: entry.projectId,
    kind: contracts.RunKinds['answer-visibility'], status: contracts.RunStatuses.completed,
    trigger: contracts.RunTriggers.manual, createdAt: now, finishedAt: now,
    ...(entry.plan ? {
      measurementPlanVersionId: entry.planVersionId,
      measurementManifest: buildMeasurementPlanV2Manifest(entry.plan),
    } : {}),
  }).run()
  for (const [index, queryId] of entry.queryIds.entries()) {
    const queryText = index === 0 ? 'best local services' : 'Example Main reviews'
    const execution = entry.plan?.executionNodes.find(node => node.queryId === queryId)
    for (const provider of providers) {
      const cited = index === 0 && provider === 'gemini'
      const mentioned = index === 0 && provider === 'claude'
      db.insert(database.querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, queryText, provider,
        citationState: cited ? contracts.CitationStates.cited : contracts.CitationStates['not-cited'],
        answerMentioned: mentioned,
        answerText: mentioned ? 'Example is one possible choice.' : 'A rival is one possible choice.',
        citedDomains: cited ? ['example.com'] : index === 1 && provider === 'gemini' ? ['rival.com'] : [],
        citedUrls: [], competitorOverlap: [], recommendedCompetitors: [],
        retrievalStatus: 'used', retrievalContract: 'native-auto-v1', captureStatus: 'complete',
        measurementExecutionId: execution?.stableKey ?? null,
        createdAt: now,
      }).run()
    }
  }
}

let baseUrl = ''
async function apiJson(method: 'GET' | 'POST', route: string, body?: unknown, etag?: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
      ...(etag === undefined ? {} : { 'if-match': etag }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const value: unknown = await response.json()
  assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`)
  return value
}

async function publishAdvancedPlan(entry: SmokeCase): Promise<void> {
  const route = `/api/v1/projects/${entry.name}/measurement-plan/draft/actions`
  let mutation = contracts.measurementDraftMutationResponseSchema.parse(
    await apiJson('POST', `${route}/create`, { expectedActiveRevision: null }),
  )
  mutation = contracts.measurementDraftMutationResponseSchema.parse(await apiJson('POST', `${route}/upsert-target`, {
    target: {
      stableKey: 'main', label: 'Main', status: 'included', aliases: ['Example Main'],
      urlMatchers: ['https://example.com/*'], source: 'manual',
    },
  }, mutation.etag))
  mutation = contracts.measurementDraftMutationResponseSchema.parse(await apiJson('POST', `${route}/apply-assignments`, {
    targetKey: 'main', queryIds: entry.queryIds,
  }, mutation.etag))
  const preview = contracts.measurementDraftCompilePreviewResponseSchema.parse(
    await apiJson('POST', `${route}/compile-preview`, {}),
  )
  assert.equal(preview.ok, true, JSON.stringify(preview))
  if (!preview.ok) throw new Error(`Advanced plan did not compile for ${entry.name}`)
  const published = contracts.measurementPlanV2PublishResponseSchema.parse(await apiJson('POST', `${route}/publish`, {
    expectedActiveRevision: null, expectedCompiledChecksum: preview.compiledChecksum,
  }, mutation.etag))
  assert.equal(published.active.plan.schemaVersion, 2)
  entry.plan = published.active.plan
  const version = db.select().from(database.measurementPlanVersions).all()
    .find(row => row.projectId === entry.projectId && row.revision === published.active.revision)
  assert.ok(version, 'Published plan version must exist in the real database')
  entry.planVersionId = version.id
}

function verifyExpectedState(entry: SmokeCase, value: CitationVisibilityResponse): void {
  if (entry.state === 'ready') {
    assert.equal(value.status, 'ready')
    assert.equal(value.summary.totalQueries, 2)
    assert.equal(value.summary.providersConfigured, 2)
    assert.equal(value.byQuery.length, 2)
    assert.equal(value.competitorGaps.length, 1)
  } else {
    assert.equal(value.status, 'no-data')
    assert.equal(value.reason, entry.state === 'no-queries' ? 'no-queries' : 'no-runs-yet')
  }
}

  assert.ok(fs.existsSync(path.join(repository, 'packages', 'canonry', 'dist', 'cli.js')), 'Build the CLI before running this harness')
  database.migrate(db)
  db.insert(database.apiKeys).values({
    id: crypto.randomUUID(), name: 'isolated-smoke', scopes: ['*'],
    keyHash: crypto.createHash('sha256').update(token).digest('hex'),
    keyPrefix: token.slice(0, 8), createdAt: now,
  }).run()
  await app.register(apiRoutes, { db, getRunnableProviderNames: () => providers })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}`
  fs.writeFileSync(path.join(temporaryDirectory, 'config.yaml'), JSON.stringify({
    apiUrl: baseUrl, database: databasePath, apiKey: token, providers: {},
    telemetry: { enabled: false }, agent: { mode: 'disabled' },
  }))
  const cases = [
    seedProject('simple-ready', 'Simple', 'ready'),
    seedProject('simple-no-runs', 'Simple', 'no-runs'),
    seedProject('simple-no-queries', 'Simple', 'no-queries'),
    seedProject('advanced-ready', 'Advanced', 'ready'),
    seedProject('advanced-no-runs', 'Advanced', 'no-runs'),
  ]
  for (const entry of cases) {
    if (entry.mode === 'Advanced') await publishAdvancedPlan(entry)
    if (entry.state === 'ready') seedRun(entry)
    const apiResponse = await apiJson('GET', `/api/v1/projects/${entry.name}/citations/visibility`)
    const expected = contracts.citationVisibilityResponseSchema.parse(apiResponse)
    assert.deepEqual(expected, apiResponse, 'Schema validation must preserve every API response field')
    verifyExpectedState(entry, expected)
    for (const format of ['json', 'jsonl'] as const) {
      const before = requests.length
      const { stdout, stderr } = await execute(process.execPath, [
        cli, '--format', format, 'citations', 'visibility', entry.name,
      ], {
        cwd: repository, env: childEnvironment, timeout: 30_000,
        windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
      })
      assert.equal(stderr, '', `${entry.name} ${format} must not print housekeeping`)
      assert.deepEqual(JSON.parse(stdout), expected, `${entry.name} ${format} must preserve the complete API DTO`)
      assert.deepEqual(requests.slice(before), [{
        method: 'GET', url: `/api/v1/projects/${entry.name}/citations/visibility`,
      }], 'Each built CLI read must make only its one stored-evidence request')
      console.log(JSON.stringify({ project: entry.name, mode: entry.mode, state: entry.state, format, result: 'pass', exitCode: 0 }))
    }
  }
  console.log(JSON.stringify({ cases: cases.length, builtCliInvocations: cases.length * 2, result: 'pass', providerCalls: 0 }))
} finally {
  await closeApp()
  closeDatabase()
  const resolvedTemporary = path.resolve(temporaryDirectory)
  assert.equal(path.dirname(resolvedTemporary), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolvedTemporary).startsWith(prefix))
  fs.rmSync(resolvedTemporary, { recursive: true, force: true })
  for (const [key, value] of previousSettings) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

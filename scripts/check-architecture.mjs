import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Mirrors noy-db-to/scripts/check-architecture.mjs's adapter-only rule:
// a single-package repo's `src/` may reach `@noy-db/hub` only through the
// published seams it's contracted to bind. Where noy-db-to binds `/adapter`,
// klum-db binds `/cargo` (orchestration seam) + `/pod` (vault-at-rest
// artifacts) — see noy-db#552.
const ROOT = process.env.ARCH_ROOT
  ? resolve(process.env.ARCH_ROOT)
  : resolve(fileURLToPath(import.meta.url), '../..')

let failures = 0
function fail(rule, msg, where) {
  failures++
  console.error(`✗ [${rule}] ${msg}${where ? ` (${relative(ROOT, where)})` : ''}`)
}

function walkTs(dir, cb) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkTs(p, cb)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) cb(p, readFileSync(p, 'utf8'))
  }
}

// klum-only-seam: src/ may import @noy-db/hub only via:
//   - '@noy-db/hub'         (root barrel — symbols with no /cargo or /pod
//                             equivalent, e.g. createNoydb, ConflictError,
//                             NoydbError, NoydbStore/EncryptedEnvelope/
//                             VaultSnapshot, ref, ...)
//   - '@noy-db/hub/cargo'   (the canonical orchestration seam — custody,
//                             deed, diff, distributed query, addressing,
//                             change-observation; see cargo-surface.golden.json)
//   - '@noy-db/hub/pod'     (vault-at-rest artifacts — writePod/readPod/
//                             readPodHeader/...; see pod-surface.golden.json)
//   - '@noy-db/hub/bundle'  (deprecated legacy alias — kept ONLY for
//                             extractPartition/adoptPartition/
//                             createOwnerOnAdoptedPartition/
//                             decryptExtractedPartition/DecryptedRecord,
//                             the source-side partition-extraction + merge
//                             primitives, which have no /cargo or /pod
//                             equivalent yet. Remove this allowance once
//                             those land on a canonical subpath.)
const ALLOWED_SUBPATHS = new Set([undefined, '/cargo', '/pod', '/bundle'])
const HUB_IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]@noy-db\/hub(\/[^'"]*)?['"]/g
function checkHubSeam() {
  walkTs(join(ROOT, 'src'), (file, code) => {
    let m
    const re = new RegExp(HUB_IMPORT_RE.source, 'g')
    while ((m = re.exec(code)) !== null) {
      const sub = m[1]
      if (!ALLOWED_SUBPATHS.has(sub)) {
        fail(
          'klum-only-seam',
          `imports '@noy-db/hub${sub ?? ''}' — klum-db must import @noy-db/hub only via the root barrel, '@noy-db/hub/cargo', or '@noy-db/hub/pod' (plus the deprecated '@noy-db/hub/bundle' allowance documented above).`,
          file,
        )
      }
    }
  })
}

checkHubSeam()

if (failures > 0) {
  console.error(`\n✗ Architecture invariants FAILED (${failures})`)
  process.exit(1)
}
console.log('✓ Architecture invariants OK')

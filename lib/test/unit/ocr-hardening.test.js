'use strict';
// Guards the OCR pool's non-blocking behavior. A single crafted or pathological page must never
// wedge a recognition worker forever and stall indexing: each page is bounded by a timeout, a worker
// that times out is terminated and replaced so the pool keeps its capacity, and a failed page is
// skipped (best-effort) rather than throwing into the batch. This is a source guard so the behavior
// cannot be quietly removed. No model, image, or network. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ocr = fs.readFileSync(path.join(ROOT, 'lib', 'ocr.js'), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // Each page's recognition is bounded, and the bound stays under the isolated child's 120s deadline
  // so a stuck page is skipped gracefully rather than the whole child being killed.
  const m = ocr.match(/PAGE_TIMEOUT_MS\s*=\s*([0-9]+)\s*\*\s*1000/);
  ok(m, 'ocr.js defines a per-page recognition timeout');
  ok(m && Number(m[1]) > 0 && Number(m[1]) < 120, `the page timeout is positive and under the child 120s deadline (${m && m[1]}s)`);

  // The batch bounds recognition with the shared raceTimeout helper (reused, not re-implemented).
  ok(/raceTimeout\(p,\s*PAGE_TIMEOUT_MS\)/.test(ocr), 'page recognition is raced against the timeout');
  ok(/require\('\.\/llm'\)/.test(ocr), 'the timeout helper is reused from the shared module');

  // A timed-out worker is replaced (pool capacity preserved); a failed page returns empty, not throws.
  ok(/const replaceWorker = async/.test(ocr), 'a worker-replacement path exists');
  ok(/_lokTimeout\) await replaceWorker\(worker\)/.test(ocr), 'a timed-out worker is replaced');
  ok(/else release\(worker\)/.test(ocr), 'a non-timeout error returns the worker to the pool');
  // A queued wait for a worker is bounded, so the inline (non-isolated) OCR path can't hang if the
  // pool were ever drained and unrecoverable.
  ok(/ACQUIRE_TIMEOUT_MS/.test(ocr) && /did not become available in time/.test(ocr), 'the worker-acquire wait is time-bounded');
  ok(/return '';/.test(ocr), 'a failed/timed-out page is skipped (returns empty), never throwing into the batch');

  // The initial pool and the replacement build workers through ONE shared factory, so they cannot
  // drift (same language, same options/cache dir).
  ok(/const createTessWorker = /.test(ocr), 'a single worker factory exists');
  ok(/Array\.from\(\{ length: poolSize\(\) \}, \(\) => createTessWorker\(\)\)/.test(ocr), 'the pool is built via the shared factory');
  ok(/const w = await createTessWorker\(\)/.test(ocr), 'the replacement uses the shared factory');

  // A late-settling recognition promise (after the timeout already won) is swallowed, so it cannot
  // surface as an unhandled rejection.
  ok(/p\.catch\(\(\) => \{\}\)/.test(ocr), 'a late promise settle is swallowed to avoid an unhandled rejection');

  // ── Offline, verified language data ──
  // Every offered pack is pinned (URL + SHA-256) in one catalog, fetched at most once, verified before
  // use, and read from a LOCAL langPath so recognition never reaches a CDN. English is the floor and
  // fails closed; an optional pack that cannot be made available is dropped and English carries on.
  const langCatalog = fs.readFileSync(path.join(ROOT, 'lib', 'ocr-languages.js'), 'utf-8');
  ok(/OCR_LANGDATA_SHA256/.test(langCatalog) && /'[0-9a-f]{64}'/.test(langCatalog),
    'the language catalog pins a 64-hex SHA-256 per pack');
  ok(/OCR_LANGDATA_URL = \(code\) =>/.test(langCatalog) && /@tesseract\.js-data/.test(langCatalog),
    'the language data source URL is built from the pinned version and code');
  ok(/sha256hex\(buf\) !== pin/.test(ocr), 'the downloaded language data is verified against the pinned checksum');
  ok(/ocrDataUnavailable: true/.test(ocr), 'an unavailable English pack fails closed (tagged error)');
  ok(/const available = wanted\.filter\(\(code, i\) => results\[i\]\)/.test(ocr),
    'an unavailable optional pack is dropped, not a fatal error');
  ok(/await ensureLangs\(\)/.test(ocr), 'the pool build ensures every selected language before creating any worker');
  ok(/opts\.langPath = _langDir/.test(ocr) && /opts\.gzip = true/.test(ocr), 'workers read the language data from the local folder (offline), not a CDN');
  ok(/writeFileAtomicAsync\(file, buf\)/.test(ocr), 'the language file is written atomically (shared disk.writeFileAtomicAsync — temp then rename)');
  ok(/_langCooldown/.test(ocr) && /_langInflight/.test(ocr),
    'a failed fetch has a per-language cooldown and concurrent ensures are deduped');
  ok(/Date\.now\(\) < \(_langCooldown\.get\(key\) \|\| 0\)/.test(ocr), 'during the cooldown a failed pack is not retried');

  console.log(`\nALL OCR-HARDENING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ OCR-HARDENING UNIT TEST FAILED:', e.message);
  process.exit(1);
}

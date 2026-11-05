'use strict';
// Unit tests for the central logger (lib/logbuffer.js): secret redaction, level gating (debug
// and progress reach the in-memory ring but NOT the console when DEBUG is off, so a long-running
// process never spams the terminal), and the dated daily-file trail with the expected name. A
// temp HOME isolates the daily log so the test never touches the real ~/.lokyni. Run: `npm run test:unit`.

const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');

// Point the home dir at a temp dir BEFORE requiring the logger, so its daily file writes land there.
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so BOTH are set — otherwise the daily
// file would be written under the real profile on Windows and this isolation would silently miss it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lokyni-log-'));
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const log = require(path.join(PROJECT, 'lib', 'logbuffer'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const restoreEnv = () => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
};
const cleanup = (code) => { restoreEnv(); try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {} process.exitCode = code; };

try {
  // ── redaction ──
  ok(log.redact('Authorization: Bearer abc.def.ghi').includes('***'), 'a bearer token is masked');
  ok(!log.redact('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'), 'the raw bearer token does not survive');
  ok(log.redact('key sk-ABCDEFGHIJKLMNOP1234').includes('***'), 'an OpenAI-style key is masked');
  ok(log.redact('plain log line about 5 documents') === 'plain log line about 5 documents', 'ordinary text is untouched');
  // Modern provider key shapes the older rules missed: sk-proj-/sk-ant- keep going after an internal
  // hyphen, Google keys start with AIza, Hugging Face tokens with hf_.
  const skProj = 'sk-proj-ABCDEFGHIJKLMNOP1234567890';
  ok(!log.redact(`using ${skProj}`).includes(skProj), 'a hyphenated sk-proj- key does not survive');
  const skAnt = 'sk-ant-api03-ABCDEFGHIJKLMNOP1234';
  ok(!log.redact(`token ${skAnt}`).includes(skAnt), 'a hyphenated sk-ant- key does not survive');
  const aiza = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  ok(!log.redact(`generateContent?key=${aiza}`).includes(aiza), 'a Google AIza key does not survive');
  ok(!log.redact(`hf_ABCDEFGHIJKLMNOP1234`).includes('hf_ABCDEFGHIJKLMNOP1234'), 'a Hugging Face hf_ token does not survive');
  ok(log.redact('{ auth: { user: "x", pass: "hunter2secret" } }').indexOf('hunter2secret') === -1, 'an SMTP pass field is masked');
  ok(log.redact('https://api.example.com/v1?key=SECRETVALUE123').indexOf('SECRETVALUE123') === -1, 'a ?key= query param is masked');
  console.log('✓ logbuffer: redaction masks secret shapes (incl. sk-proj-/sk-ant-/AIza/hf_/pass/?key=), leaves ordinary text alone');

  // ── source guards: the daily file has a size ceiling and retention prunes rolled generations ──
  const bufSrc = fs.readFileSync(path.join(PROJECT, 'lib', 'logbuffer.js'), 'utf-8');
  ok(/MAX_FILE_BYTES\s*=/.test(bufSrc) && /dayBytes \+ n > MAX_FILE_BYTES/.test(bufSrc),
    'the daily file rolls to a new generation once it exceeds a byte cap');
  ok(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\(\?:\\\.\\d\+\)\?\\\.log\$/.test(bufSrc),
    'the retention prune regex matches the size-rolled YYYY-MM-DD.N.log files too');

  // ── level gating: debug/progress reach the ring but not the console (DEBUG is off in tests) ──
  const realLog = console.log;
  let consoleCalls = 0;
  console.log = () => { consoleCalls++; };
  try {
    log.debug('DEBUG_MARKER_LINE');
    log.progress('PROGRESS_MARKER_LINE');
  } finally { console.log = realLog; }
  ok(consoleCalls === 0, 'debug/progress do not print to the console when DEBUG is off');
  const ringText = log.recent(50).map(e => e.line).join('\n');
  ok(ringText.includes('DEBUG_MARKER_LINE') && ringText.includes('PROGRESS_MARKER_LINE'), 'debug/progress still reach the in-memory ring');
  console.log('✓ logbuffer: debug/progress are captured but stay off the console when quiet');

  // ── console capture: install() must route EVERY stdout/stderr-defaulting console method into the ring, so
  //    nothing a module (or a dependency) prints escapes the in-app log viewer the desktop app reads. ──
  ok(/wrap\('log',\s*'stdout'\)/.test(bufSrc) && /wrap\('info',\s*'stdout'\)/.test(bufSrc)
    && /wrap\('debug',\s*'stdout'\)/.test(bufSrc) && /wrap\('warn',\s*'stderr'\)/.test(bufSrc)
    && /wrap\('error',\s*'stderr'\)/.test(bufSrc),
    'install() wraps log, info, debug (stdout) and warn, error (stderr) — console.debug included so no server output escapes');
  log.install();   // idempotent; wraps console.* in place (the wrapper still calls the real stream)
  const DBG = 'CAPTURE_DEBUG_' + Date.now();
  const INF = 'CAPTURE_INFO_' + Date.now();
  console.debug(DBG);
  console.info(INF);
  const capText = log.recent(50).map(e => e.line).join('\n');
  ok(capText.includes(DBG), 'console.debug output is captured into the ring (visible in the in-app viewer)');
  ok(capText.includes(INF), 'console.info output is captured into the ring');
  console.log('✓ logbuffer: install() captures console.debug/info into the ring for the in-app viewer');

  // ── dated daily file: a YYYY-MM-DD.log exists under the temp HOME and holds the lines ──
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dailyPath = path.join(tmpHome, '.lokyni', 'logs', `${stamp}.log`);
  // The write stream flushes asynchronously; give it a tick, then assert.
  setTimeout(() => {
    try {
      ok(fs.existsSync(dailyPath), 'a dated daily log file (YYYY-MM-DD.log) is created');
      const contents = fs.readFileSync(dailyPath, 'utf8');
      ok(contents.includes('DEBUG_MARKER_LINE'), 'the daily file records the gated lines (full trail on disk)');
      console.log('✓ logbuffer: a dated daily log file captures the full trail');
      console.log(`\nALL LOGBUFFER UNIT TESTS PASSED (${checks} checks)`);
      cleanup(0);
    } catch (e) {
      console.error('\n✗ LOGBUFFER UNIT TEST FAILED:', e && e.message);
      cleanup(1);
    }
  }, 200);
} catch (e) {
  console.error('\n✗ LOGBUFFER UNIT TEST FAILED:', e && e.message);
  cleanup(1);
}

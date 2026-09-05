/**
 * test/xml.test.js — every Android XML file must parse.
 *
 * =============================================================================
 * WHY A SERVER TEST SUITE VALIDATES THE APP'S XML
 *
 * Because it is the only automated gate in this repository that runs before a
 * package is handed over. `./gradlew` runs on Riad's machine, not here, so a
 * malformed manifest is invisible to me until it fails HIS build — which is
 * exactly what happened:
 *
 *     Error parsing AndroidManifest.xml
 *     The string "--" is not permitted within comments. lineNumber: 5
 *
 * The cause was a regex edit that replaced the FIRST LINE of a multi-line
 * comment, leaving `<!-- SMS.` dangling and opening a second `<!--` inside it.
 * A single line looked fine in isolation; the file did not.
 *
 * The lesson is not "be careful with regex". It is that a change to a structured
 * file has to be validated as a FILE, and I had validated dialog_settings.xml
 * after editing it earlier in the same session and simply not the manifest. The
 * same omission, one file over.
 * =============================================================================
 *
 * Run: node test/xml.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', 'app', 'app', 'src', 'main');

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.xml')) out.push(p);
    }
    return out;
}

const files = walk(ROOT);

// Not an assertion failure: the server half is deployable on its own, and a
// checkout without the app directory should not fail the server suite.
if (files.length === 0) {
    console.log('ok — no Android XML found (server-only checkout), nothing to validate');
    process.exit(0);
}

/**
 * Parse with Python's expat, which is what is available here and is strict about
 * exactly the things Android's manifest merger is strict about — including the
 * "--" rule that broke the build.
 */
function parses(file) {
    try {
        execFileSync('python3', ['-c',
            'import sys,xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])', file],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        return null;
    } catch (e) {
        return String(e.stderr || e.message).trim().split('\n').pop();
    }
}

const broken = [];
for (const f of files) {
    const err = parses(f);
    if (err) broken.push(`${path.relative(ROOT, f)} — ${err}`);
}

assert.deepStrictEqual(broken, [],
    'malformed Android XML would fail the build on the developer\'s machine, which '
    + 'is the one place I cannot see:\n  ' + broken.join('\n  '));

// The specific rule that caused the failure, checked directly as well. A parser
// upgrade that quietly relaxed it would take the regression with it.
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
        assert.ok(!m[1].includes('--'),
            `${path.relative(ROOT, f)}: a comment contains "--", which XML forbids. `
            + 'This is what a regex edit into the middle of a multi-line comment '
            + 'produces, and it fails the manifest merger.');
    }
}

console.log(`ok — ${files.length} Android XML files parse, and no comment contains "--"`);

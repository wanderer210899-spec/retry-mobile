const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = __dirname;

test('backend never emits per-accepted Termux success notifications', () => {
    const offenders = collectServerSources()
        .filter((entry) => /notify\([^)]*['"]success['"]/.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SERVER_ROOT, entry.filePath)),
        [],
        'Termux notifications are terminal-only; do not call notify(..., "success", ...)',
    );
});

function collectServerSources() {
    return fs.readdirSync(SERVER_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
        .map((entry) => {
            const filePath = path.join(SERVER_ROOT, entry.name);
            return {
                filePath,
                source: fs.readFileSync(filePath, 'utf8'),
            };
        });
}

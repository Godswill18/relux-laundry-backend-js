// Which git commit this process is running — reported by /health so a stale
// deployment is obvious. A manually bumped "revision" string could not tell two
// commits apart (both said the same thing), which is exactly how an old
// container kept serving unnoticed after a fix was pushed.
//
// Read once at startup from the .git folder that ships in the image (the repo
// has no .dockerignore, so Nixpacks' `COPY . /app` includes it). Falls back to
// commit variables some platforms set. Never throws — unknown is reported as null.
const fs = require('fs');
const path = require('path');

function readCommit() {
  for (const v of ['SOURCE_COMMIT', 'GIT_COMMIT', 'COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA']) {
    if (process.env[v]) return process.env[v].slice(0, 40);
  }
  try {
    const gitDir = path.join(__dirname, '..', '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head; // detached HEAD: the SHA itself
    const ref = head.slice(4).trim();
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0] : null;
  } catch (_) {
    return null;
  }
}

const COMMIT = readCommit();
module.exports = { COMMIT, COMMIT_SHORT: COMMIT ? COMMIT.slice(0, 7) : null };

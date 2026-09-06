// Ships the local working tree into a sandbox as a plain source tree, then makes it a git
// repo with a single BASE commit.
//
// Why a fresh `git init` from a tarball instead of cloning from GitHub:
//   1. it captures exactly the LOCAL HEAD (or working tree, with --dirty), even if unpushed;
//   2. `git diff --quiet` (the staleness stage) and `git diff BASE..HEAD` (the tournament's
//      per-variant patch) both work against a real, local base commit;
//   3. the sandbox gets NO git remote and no credentials — it is structurally unable to push
//      or deploy (improvement-loop lessons 18b/29). Defense in depth beside the network
//      whitelist, which doesn't include the Cloudflare API anyway.
//
// Ignored files (node_modules, *.pdf, *.xlsx, .env) are excluded for free: `git archive` only
// emits tracked files, and the --dirty path uses `git ls-files --exclude-standard`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStep, repoDir } from './sandbox.mjs';
import { InfraError } from './util.mjs';

const git = (repoRoot, args, opts = {}) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// Build a tarball of the source to ship. Returns a local path; caller deletes it.
export function makeSourceTar(repoRoot, { dirty }) {
  const tmp = mkdtempSync(join(tmpdir(), 'hb-daytona-'));
  const tarPath = join(tmp, 'repo.tar');

  if (!dirty) {
    // Exactly the committed HEAD tree.
    git(repoRoot, ['archive', '--format=tar', '-o', tarPath, 'HEAD']);
  } else {
    // Current working tree: tracked ∪ untracked-but-not-ignored (disjoint sets). Null-delimited
    // to be safe, though this repo has no newlines in paths.
    const tracked = git(repoRoot, ['ls-files', '-z']);
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
    const listPath = join(tmp, 'files0');
    execFileSync('bash', ['-c', `cat > '${listPath}'`], { input: tracked + untracked });
    // BSD tar (macOS host) and GNU tar both accept --null -T.
    execFileSync('tar', ['-cf', tarPath, '--null', '-T', listPath], { cwd: repoRoot });
  }
  return { tarPath, tmpDir: tmp };
}

// Local counts for the report header (what we're shipping).
export function describeTree(repoRoot, { dirty }) {
  const head = git(repoRoot, ['rev-parse', '--short', 'HEAD']).trim();
  let dirtyFiles = 0;
  if (dirty) {
    const s = git(repoRoot, ['status', '--porcelain']).trim();
    dirtyFiles = s ? s.split('\n').length : 0;
  }
  return { head, dirty: !!dirty, dirtyFiles };
}

// Upload + unpack + init + BASE commit inside the sandbox. Returns { dir, baseSha }.
export async function prepareRepo(sandbox, { repoRoot, dirty, log }) {
  const dir = await repoDir(sandbox);
  const tarRemote = `${dir.replace(/\/repo$/, '')}/repo.tar`; // sibling of the repo dir
  const { tarPath, tmpDir } = makeSourceTar(repoRoot, { dirty });

  try {
    let r = await runStep(sandbox, `mkdir -p '${dir}'`, { deadlineSec: 60, label: 'prep:mkdir' });
    if (r.exitCode !== 0) throw new InfraError(`mkdir failed: ${r.output.slice(-400)}`);

    try {
      await sandbox.fs.uploadFile(tarPath, tarRemote, 180);
    } catch (err) {
      throw new InfraError(`Bundle upload failed: ${err?.message || err}`);
    }
    log?.('uploaded source tarball');

    r = await runStep(sandbox, `tar xf '${tarRemote}' -C '${dir}' && rm -f '${tarRemote}'`, { deadlineSec: 120, label: 'prep:untar' });
    if (r.exitCode !== 0) throw new InfraError(`untar failed: ${r.output.slice(-400)}`);

    // Fresh repo, one BASE commit. -c sets identity without touching global config.
    const idflags = `-c user.name='hb-daytona' -c user.email='hb-daytona@local'`;
    r = await runStep(
      sandbox,
      `git init -q && git ${idflags} add -A && git ${idflags} commit -q -m BASE && git rev-parse HEAD`,
      { cwd: dir, deadlineSec: 90, label: 'prep:commit' },
    );
    if (r.exitCode !== 0) throw new InfraError(`git init/commit failed: ${r.output.slice(-400)}`);
    const baseSha = r.output.trim().split('\n').pop().trim();
    log?.(`BASE commit ${baseSha.slice(0, 8)}`);
    return { dir, baseSha };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

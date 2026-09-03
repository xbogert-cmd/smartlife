// Builds the whisper.cpp CLI once, into resources/whisper-cli (git-ignored),
// so it can be bundled via electron-builder extraResources. Runs on
// postinstall; no-ops if the binary is already there.
//
// Requires: git, cmake. macOS: `brew install cmake` if missing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WHISPER_CPP_REF = 'v1.7.6';
const OUT = join(process.cwd(), 'resources', 'whisper-cli');

if (existsSync(OUT)) {
  console.log('[fetch-whisper] resources/whisper-cli already present, skipping');
  process.exit(0);
}

try {
  execFileSync('cmake', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('[fetch-whisper] cmake not found. Install it (macOS: `brew install cmake`) and re-run `npm install`.');
  process.exit(1);
}

// Find a file by name anywhere under dir (returns the first hit or null).
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

const work = join(tmpdir(), `whisper-cpp-${WHISPER_CPP_REF}-${Date.now()}`);
try {
  console.log(`[fetch-whisper] cloning whisper.cpp ${WHISPER_CPP_REF}`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', WHISPER_CPP_REF,
    'https://github.com/ggerganov/whisper.cpp', work], { stdio: 'inherit' });

  const build = join(work, 'build');
  execFileSync('cmake', ['-S', work, '-B', build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_METAL_EMBED_LIBRARY=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
  ], { stdio: 'inherit' });
  execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j'], { stdio: 'inherit' });

  const built = existsSync(join(build, 'bin', 'whisper-cli'))
    ? join(build, 'bin', 'whisper-cli')
    : findFile(build, 'whisper-cli');
  if (!built) throw new Error('[fetch-whisper] build finished but whisper-cli was not found under build/');

  mkdirSync(join(process.cwd(), 'resources'), { recursive: true });
  copyFileSync(built, OUT);
  chmodSync(OUT, 0o755);
  console.log(`[fetch-whisper] wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

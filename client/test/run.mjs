import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = import.meta.dirname;
const outdir = join(testDir, '..', '.test-build');
const entries = readdirSync(testDir).filter(f => f.endsWith('.test.ts'));
rmSync(outdir, { recursive: true, force: true });
await build({
    entryPoints: entries.map(f => join(testDir, f)),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node24'],
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning'
});

// File paths, not the directory: Node 24's --test does not expand directories.
const files = entries.map(f => join(outdir, f.replace(/\.ts$/, '.mjs')));
const result = spawnSync(process.execPath, ['--test', '--test-timeout=10000', ...files], { stdio: 'inherit' });
if (result.error) {
    console.error(result.error);
}
process.exit(result.status ?? 1);

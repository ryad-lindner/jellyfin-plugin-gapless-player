import { build } from 'esbuild';

// Bundle the client into a single classic script (IIFE) that registers
// window.GaplessPlayer. It is written into the C# project so it can be embedded
// as a resource and dropped next to index.html by the server-side injector.
await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    legalComments: 'none',
    outfile: '../Jellyfin.Plugin.GaplessPlayer/Web/gaplessPlayer.js'
});

console.log('Built gaplessPlayer.js');

import { defineConfig } from 'tsdown'

/**
 * The bundle ships its manifest anchor, Host plugins, prompt policy, and the
 * stdio vision MCP server the bridge spawns under plain Node.
 * MCP SDK and zod stay external and resolve from
 * this package's own dependencies at runtime.
 */
export default defineConfig([
  {
    entry: ['lib/types/prompt-language.js', 'lib/types/prompt-policy.js', 'lib/types/skill-policy.js', 'lib/types/agent-policy.js'],
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
  },
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/vision-bridge.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/skills-routes.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/mcp-vision-server.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])

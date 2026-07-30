import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the session page owns a live WS + AudioContext; double-mount breaks it
  serverExternalPackages: ['pg', 'ws'],

  // Pin the workspace root to this directory. A stray package-lock.json further
  // up the tree (e.g. in your home directory) otherwise makes Next infer that
  // as the root, which breaks module resolution with errors like
  // "Cannot find module '@swc/helpers/package.json'".
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;

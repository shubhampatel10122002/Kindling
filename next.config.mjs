/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the session page owns a live WS + AudioContext; double-mount breaks it
  serverExternalPackages: ['pg'],
};

export default nextConfig;

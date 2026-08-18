import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Los paquetes internos exponen TS sin compilar; Next los transpila.
  transpilePackages: ['@sondadata/schema', '@sondadata/engine'],
};

export default nextConfig;

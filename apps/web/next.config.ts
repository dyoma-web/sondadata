import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Los paquetes internos exponen TS sin compilar; Next los transpila.
  transpilePackages: ['@sondadata/schema', '@sondadata/engine'],
  // La web actúa de proxy hacia el worker: el navegador solo habla con un
  // origen. Imprescindible en Codespaces y cómodo en producción.
  async rewrites() {
    const worker = process.env.WORKER_INTERNAL_URL ?? 'http://localhost:8787';
    return [{ source: '/api/worker/:path*', destination: `${worker}/:path*` }];
  },
};

export default nextConfig;

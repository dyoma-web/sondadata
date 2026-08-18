import type { Metadata } from 'next';
import TopBar from '../components/TopBar';
import './globals.css';

export const metadata: Metadata = {
  title: 'SondaData — diagnóstico de datos en una sola pasada',
  description:
    'Sube tus archivos desordenados y obtén el mapa real de tus datos, un diagnóstico de calidad y los cruces posibles, con evidencia verificable.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <TopBar />
        {children}
      </body>
    </html>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function TopBar() {
  const path = usePathname();
  const item = (href: string, label: string, enabled = true) => {
    const active = href === '/' ? path === '/' : path.startsWith(href);
    if (!enabled) return <span title="Disponible tras el primer análisis">{label}</span>;
    return (
      <Link href={href} className={active ? 'active' : ''}>
        {label}
      </Link>
    );
  };
  return (
    <div className="topbar">
      <span className="brand">SondaData</span>
      <nav>
        {item('/', '1 · Conectar')}
        {item('/mapa', '2 · Mapa')}
        {item('/cruces', '3 · Cruces')}
      </nav>
    </div>
  );
}

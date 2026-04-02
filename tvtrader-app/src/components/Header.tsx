'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Header() {
  const pathname = usePathname();
  return (
    <header className="border-b border-card-border bg-card">
      <div className="mx-auto px-4 sm:px-6 lg:px-10 2xl:px-16">
        <div className="flex items-center justify-between h-14 lg:h-16">
          <div className="flex items-center gap-6 lg:gap-8">
            <h1 className="text-lg lg:text-xl font-bold text-accent tracking-tight">TV Trader</h1>
            <nav className="flex gap-1">
              {[
                { href: '/', label: 'Dashboard' },
                { href: '/performance', label: 'Performance' },
                { href: '/signals', label: 'Signals' },
                { href: '/settings', label: 'Settings' },
              ].map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={`px-3 py-1.5 lg:px-4 lg:py-2 rounded text-sm lg:text-base font-medium transition-colors ${
                    pathname === href ? 'bg-accent/10 text-accent' : 'text-muted hover:text-foreground'
                  }`}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </header>
  );
}

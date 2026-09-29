import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { Providers } from './providers';
import { TopHeader } from '@/components/layout/TopHeader';
import { Sidebar } from '@/components/layout/Sidebar';
import { BottomNav } from '@/components/layout/BottomNav';

export const metadata: Metadata = {
  title: 'Track - Malaysian Vehicle Plate Detection & Matching System',
  description: 'Enterprise PWA for Malaysian Vehicle License Plate Recognition, ANPR, Repo Matching & Case Management.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Track ANPR',
  },
};

export const viewport: Viewport = {
  themeColor: '#06B6D4',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <Script
          id="clear-stale-service-worker"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(function(registrations) {
                  for (let r of registrations) { r.unregister(); }
                });
              }
              if (window.caches) {
                caches.keys().then(function(keys) {
                  for (let k of keys) { caches.delete(k); }
                });
              }
            `,
          }}
        />
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased flex flex-col selection:bg-cyan-500 selection:text-slate-950">
        <Providers>
          <TopHeader />
          <div className="app-shell flex flex-1 w-full min-w-0">
            <Sidebar />
            <main className="app-main flex-1 min-w-0 w-full max-w-[1480px] mx-auto p-3 sm:p-5 md:p-6 xl:p-8 pb-24 lg:pb-8 overflow-x-hidden">
              {children}
            </main>
          </div>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}

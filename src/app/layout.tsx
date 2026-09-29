import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { TopHeader } from '@/components/layout/TopHeader';
import { Sidebar } from '@/components/layout/Sidebar';
import { BottomNav } from '@/components/layout/BottomNav';
import { ServiceWorkerCleanup } from '@/components/layout/ServiceWorkerCleanup';

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
      </head>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased flex flex-col selection:bg-cyan-500 selection:text-slate-950">
        <Providers>
          <ServiceWorkerCleanup />
          <TopHeader />
          <div className="app-shell flex flex-1 w-full min-w-0">
            <Sidebar />
            <main className="app-main flex-1 min-w-0 w-full max-w-[1480px] mx-auto px-4 pt-5 pb-28 sm:px-5 sm:pt-5 sm:pb-28 md:px-6 md:pt-6 md:pb-28 lg:p-6 xl:p-8 lg:pb-8 overflow-x-hidden">
              {children}
            </main>
          </div>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}

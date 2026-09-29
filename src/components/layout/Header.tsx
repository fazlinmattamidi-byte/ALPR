'use client';

import React from 'react';
import Link from 'next/link';
import { Car, Settings } from 'lucide-react';

export const Header: React.FC = () => {
  return (
    <header className="sticky top-0 z-40 w-full bg-[#090a0f]/90 backdrop-blur-md border-b border-[#252833]">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <div className="w-9 h-9 rounded-lg bg-[#00d8f6] flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-[#00d8f6]/20 transition-transform group-hover:scale-105">
            <Car className="w-5 h-5 fill-slate-950 stroke-slate-950" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white flex items-center gap-1.5">
            Plate<span className="text-[#00d8f6]">Q</span>
          </span>
        </Link>

        {/* Top Right Quick Actions */}
        <div className="flex items-center gap-2">
          <Link
            href="/settings"
            className="p-2 text-slate-400 hover:text-white hover:bg-[#16181e] rounded-lg transition-colors border border-transparent hover:border-[#252833]"
            aria-label="Tetapan"
          >
            <Settings className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </header>
  );
};

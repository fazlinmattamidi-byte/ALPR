'use client';

import React from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: number | string;
  icon: LucideIcon;
  accentColor?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  accentColor = 'text-[#00d8f6]',
}) => {
  return (
    <div className="bg-[#16181e] border border-[#252833] rounded-2xl p-5 shadow-sm transition-all hover:border-[#2f3444] hover:bg-[#1b1e27]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
          {title}
        </span>
        <Icon className={`w-5 h-5 ${accentColor}`} />
      </div>
      <div className="text-3xl font-extrabold tracking-tight text-white font-sans">
        {value}
      </div>
    </div>
  );
};

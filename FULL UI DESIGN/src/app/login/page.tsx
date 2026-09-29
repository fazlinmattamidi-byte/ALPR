'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { useStorage } from '@/context/StorageContext';
import { Role } from '@/types';
import Image from 'next/image';
import { ShieldAlert, ShieldCheck, UserCheck, User as UserIcon, ArrowRight, Lock, Mail } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const { loginAs } = useAuth();
  const { users } = useStorage();
  const { t } = useLanguage();

  const [selectedRole, setSelectedRole] = useState<Role>('SUPER_ADMIN');
  const [email, setEmail] = useState('superadmin@track.my');
  const [password, setPassword] = useState('••••••••••••');

  const handleSelectRole = (r: Role) => {
    setSelectedRole(r);
    const user = users.find((u) => u.role === r);
    if (user) {
      setEmail(user.email);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Lookup matching user by email or role
    const matchedUser =
      users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ||
      users.find((u) => u.role === selectedRole) ||
      users[0];

    loginAs(matchedUser);
    router.push('/');
  };

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center py-10 px-4">
      <div className="w-full max-w-md space-y-8">
        {/* Header Logo */}
        <div className="text-center space-y-3">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-slate-950 items-center justify-center shadow-xl shadow-cyan-500/20 border border-cyan-400/40 overflow-hidden">
            <Image
              src="/logo.png"
              alt="TRACK Logo"
              width={64}
              height={64}
              className="w-full h-full object-cover"
              priority
            />
          </div>
          <h1 className="text-3xl font-black tracking-wider text-white">TRACK</h1>
          <p className="text-sm text-slate-400 font-medium max-w-xs mx-auto">
            {t('appSubName')}
          </p>
        </div>

        {/* Demo Role Switcher Card */}
        <div className="bg-slate-900/90 border border-cyan-900/50 rounded-2xl p-4 shadow-xl backdrop-blur-md space-y-3">
          <div className="text-xs font-bold text-cyan-400 uppercase tracking-widest text-center">
            {t('demoRole')} (Select for Demo)
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { role: 'USER' as Role, label: t('roleUser'), icon: UserIcon, color: 'border-slate-700 text-slate-300' },
              { role: 'ADMIN' as Role, label: t('roleAdmin'), icon: UserCheck, color: 'border-blue-500/50 text-blue-400' },
              { role: 'SUPER_ADMIN' as Role, label: 'Super Admin', icon: ShieldCheck, color: 'border-cyan-500/50 text-cyan-400' },
            ].map((r) => {
              const Icon = r.icon;
              const isSelected = selectedRole === r.role;
              return (
                <button
                  key={r.role}
                  type="button"
                  onClick={() => handleSelectRole(r.role)}
                  className={`flex flex-col items-center p-3 rounded-xl border text-xs font-bold transition-all ${
                    isSelected
                      ? 'bg-cyan-950/90 border-cyan-400 text-cyan-300 shadow-md shadow-cyan-950'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  <Icon className={`w-5 h-5 mb-1 ${isSelected ? 'text-cyan-400' : 'text-slate-500'}`} />
                  <span className="text-[10px] text-center leading-tight">{r.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md space-y-5">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">{t('loginTitle')}</h2>
            <p className="text-xs text-slate-400">{t('loginSubtitle')}</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/25 transition-all duration-200"
          >
            <span>{t('loginButton')}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

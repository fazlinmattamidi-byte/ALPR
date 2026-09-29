'use client';

import React, { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { useStorage } from '@/context/StorageContext';
import {
  ShieldCheck,
  UserCheck,
  User as UserIcon,
  LogOut,
  Check,
  Save,
  Mail,
  Phone,
  LockKeyhole,
  BadgeCheck,
} from 'lucide-react';

export default function ProfilePage() {
  const { currentUser, role, logout, updateProfile } = useAuth();
  const { t } = useLanguage();
  const { updateUser } = useStorage();

  const [nameInput, setNameInput] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

  const displayName = nameInput ?? currentUser?.name ?? '';
  const displayEmail = emailInput ?? currentUser?.email ?? '';
  const displayPhone = phoneInput ?? currentUser?.phone ?? '';

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !displayEmail.trim()) return;

    const updatedData = {
      name: displayName.trim(),
      email: displayEmail.trim(),
      phone: displayPhone.trim(),
    };

    updateProfile(updatedData);

    if (currentUser) {
      updateUser({
        ...currentUser,
        ...updatedData,
      });
    }

    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 3000);
    setNameInput(null);
    setEmailInput(null);
    setPhoneInput(null);
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword) return;
    setPasswordSaved(true);
    setTimeout(() => setPasswordSaved(false), 3000);
    setOldPassword('');
    setNewPassword('');
  };

  return (
    <div className="profile-page w-full max-w-6xl mx-auto space-y-4 sm:space-y-6 xl:space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.2em] sm:tracking-[0.24em] text-cyan-400">TRACK ANPR</p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white tracking-wide leading-tight">
            {t('profileTitle')}
          </h1>
        </div>
        <div className="hidden lg:flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-300">
          <BadgeCheck className="w-4 h-4 text-emerald-400" />
          <span>Verified operational account</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4 sm:gap-5 xl:gap-6 items-start">
        <div className="space-y-3 sm:space-y-5 lg:sticky lg:top-24">
          <section className="profile-card bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl backdrop-blur-md">
            <div className="flex items-center gap-4 text-left sm:flex-col sm:text-center">
              <div className="w-14 h-14 sm:w-24 sm:h-24 rounded-2xl bg-cyan-950 border-2 border-cyan-500/50 flex items-center justify-center text-cyan-300 text-2xl sm:text-3xl font-black shadow-lg shadow-cyan-500/20 uppercase shrink-0">
                {displayName ? displayName.charAt(0) : 'U'}
              </div>

              <div className="min-w-0 space-y-2 sm:mt-4 max-w-full">
                <h2 className="truncate text-lg sm:text-2xl font-black text-white leading-tight sm:break-words">
                  {currentUser?.name || 'Officer User'}
                </h2>
                <span
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase w-fit sm:mx-auto flex items-center gap-1 ${
                    role === 'SUPER_ADMIN'
                      ? 'bg-cyan-950 text-cyan-400 border border-cyan-800'
                      : role === 'ADMIN'
                      ? 'bg-blue-950 text-blue-400 border border-blue-800'
                      : 'bg-slate-950 text-slate-400 border border-slate-800'
                  }`}
                >
                  {role === 'SUPER_ADMIN' ? (
                    <ShieldCheck className="w-3 h-3" />
                  ) : role === 'ADMIN' ? (
                    <UserCheck className="w-3 h-3" />
                  ) : (
                    <UserIcon className="w-3 h-3" />
                  )}
                  <span>{role}</span>
                </span>
              </div>
            </div>

            <div className="mt-4 sm:mt-6 space-y-2 sm:space-y-3">
              <div className="profile-meta-row flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3.5 py-2.5 sm:py-3">
                <Mail className="w-4 h-4 text-cyan-400 shrink-0" />
                <span className="min-w-0 truncate text-xs text-slate-300 font-mono">{currentUser?.email}</span>
              </div>
              <div className="profile-meta-row flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3.5 py-2.5 sm:py-3">
                <Phone className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="min-w-0 truncate text-xs text-slate-300 font-mono">{currentUser?.phone}</span>
              </div>
            </div>
          </section>

          <section className="profile-card hidden sm:block bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-cyan-950 border border-cyan-800 p-2.5">
                <LockKeyhole className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-sm font-black text-white uppercase tracking-wider">Account Access</h3>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Credentials control dashboard access for plate search, scanner review, and audit actions.
                </p>
              </div>
            </div>
          </section>

          <section className="profile-card bg-slate-900/90 border border-slate-800 rounded-2xl p-3 sm:p-5 shadow-xl">
            <button
              onClick={logout}
              className="w-full py-2.5 sm:py-3 rounded-xl bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-800 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all"
            >
              <LogOut className="w-4 h-4 text-red-400" />
              <span>{t('navLogout')}</span>
            </button>
          </section>
        </div>

        <div className="space-y-3 sm:space-y-5">
          <section className="profile-card bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 sm:space-y-5">
            <h3 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3 sm:pb-4 leading-tight">
              {t('editProfileInfo')}
            </h3>

            <form onSubmit={handleProfileSubmit} className="space-y-4 sm:space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('fullNameLabel')} *
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="e.g. Inspector Hafiz"
                    className="profile-input w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 sm:py-3 text-sm font-bold text-white focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('phoneNumberLabel')}
                  </label>
                  <input
                    type="text"
                    value={displayPhone}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="+60 12-345 6789"
                    className="profile-input w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 sm:py-3 text-sm font-mono text-white focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t('emailAddressLabel')} *
                </label>
                <input
                  type="email"
                  value={displayEmail}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="officer@track.gov.my"
                  className="profile-input w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 sm:py-3 text-sm font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div className="flex items-center justify-end pt-3 sm:pt-4 border-t border-slate-800">
                <button
                  type="submit"
                  className="profile-primary-button w-full sm:w-auto px-5 py-2.5 sm:py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20"
                >
                  {profileSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  <span>{profileSaved ? t('profileSavedBtn') : t('saveProfileBtn')}</span>
                </button>
              </div>
            </form>
          </section>

          <section className="profile-card bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 sm:space-y-5">
            <h3 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3 sm:pb-4 leading-tight">
              {t('changePassword')}
            </h3>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('oldPassword')}
                  </label>
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="********"
                    className="profile-input w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 sm:py-3 text-sm text-white focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('newPassword')}
                  </label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="********"
                    className="profile-input w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 sm:py-3 text-sm text-white focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  className="profile-secondary-button w-full sm:w-auto px-4 py-2.5 sm:py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-all flex items-center justify-center gap-2"
                >
                  {passwordSaved ? <Check className="w-4 h-4 text-emerald-400" /> : null}
                  <span>{passwordSaved ? t('passwordUpdatedBtn') : t('updatePasswordBtn')}</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

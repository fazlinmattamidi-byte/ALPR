'use client';

import React, { useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { formatDate } from '@/lib/utils';
import { UserAccount, Role } from '@/types';
import {
  Users,
  UserPlus,
  ShieldCheck,
  UserCheck,
  User as UserIcon,
  Key,
  Ban,
  X,
  Eye,
  Edit2,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

export default function UsersPage() {
  const { users, history, addUser, updateUser, toggleUserStatus, deleteUser } = useStorage();
  const { t } = useLanguage();
  const { currentUser, role, canManageUsers, canManageSystem } = useAuth();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [resetPassUser, setResetPassUser] = useState<UserAccount | null>(null);
  const [viewingUser, setViewingUser] = useState<UserAccount | null>(null);
  const [newPasswordInput, setNewPasswordInput] = useState('Pass1234#');

  const [formData, setFormData] = useState<{
    name: string;
    email: string;
    phone: string;
    role: Role;
    status: 'ACTIVE' | 'DISABLED';
    avatar: string;
  }>({
    name: '',
    email: '',
    phone: '+60 12-000 8888',
    role: 'USER',
    status: 'ACTIVE',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=250&q=80',
  });

  const openAddModal = () => {
    setFormData({
      name: '',
      email: '',
      phone: '+60 12-000 8888',
      role: 'USER',
      status: 'ACTIVE',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=250&q=80',
    });
    setEditingUser(null);
    setIsAddModalOpen(true);
  };

  const openEditModal = (u: UserAccount) => {
    setEditingUser(u);
    setFormData({
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      status: u.status,
      avatar: u.avatar,
    });
    setIsAddModalOpen(true);
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.email) return;

    if (editingUser) {
      updateUser({
        ...editingUser,
        ...formData,
      });
    } else {
      addUser({
        ...formData,
        role: canManageSystem ? formData.role : 'USER',
        createdBy: currentUser?.id,
      });
    }
    setIsAddModalOpen(false);
  };

  const handleDeleteConfirm = () => {
    if (deletingUserId) {
      deleteUser(deletingUserId);
      setDeletingUserId(null);
    }
  };

  const handleResetPasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (resetPassUser) {
      alert(`Password for ${resetPassUser.name} successfully reset to "${newPasswordInput}"`);
      setResetPassUser(null);
    }
  };

  const deletingTarget = users.find((u) => u.id === deletingUserId);
  const visibleUsers =
    role === 'SUPER_ADMIN'
      ? users
      : role === 'ADMIN'
      ? users.filter((u) => u.createdBy === currentUser?.id)
      : users.filter((u) => u.id === currentUser?.id);
  const viewingUserHistory = viewingUser
    ? history
        .filter((log) => {
          const belongsToViewingUser = log.actorId
            ? log.actorId === viewingUser.id
            : role === 'SUPER_ADMIN'
            ? log.userRole === viewingUser.role
            : log.userRole === viewingUser.role && viewingUser.createdBy === currentUser?.id;
          const allowedForUser = viewingUser.role !== 'USER' || log.type === 'SEARCH' || log.type === 'DETECTION';
          return belongsToViewingUser && allowedForUser;
        })
        .slice(0, 5)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-wide">
            {t('manageUsersTitle')}
          </h1>
        </div>

        {canManageUsers && (
          <button
            onClick={openAddModal}
            className="px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-lg shadow-cyan-500/20 transition-all"
          >
            <UserPlus className="w-4 h-4" />
            <span>{t('addUser')}</span>
          </button>
        )}
      </div>

      {/* User Table Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        {/* Mobile View: User Cards */}
        <div className="sm:hidden p-3 space-y-2.5">
          {visibleUsers.map((u) => (
            <div key={u.id} className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-slate-800 border border-cyan-500/40 flex items-center justify-center text-cyan-400 font-bold text-xs uppercase overflow-hidden shrink-0">
                    {u.name.charAt(0)}
                  </div>
                  <div>
                    <div className="font-bold text-xs text-white">{u.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{u.email}</div>
                  </div>
                </div>
                <button
                  onClick={() => canManageUsers && toggleUserStatus(u.id)}
                  className={`inline-flex items-center justify-center w-20 h-5.5 rounded text-[9px] font-black uppercase tracking-wider text-center ${
                    u.status === 'ACTIVE'
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : 'bg-red-950 text-red-400 border border-red-800'
                  }`}
                >
                  {u.status}
                </button>
              </div>

              <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-800/60">
                <span
                  className={`inline-flex items-center justify-center w-28 h-5.5 rounded-full text-[9px] font-bold uppercase tracking-wider text-center whitespace-nowrap ${
                    u.role === 'SUPER_ADMIN'
                      ? 'bg-cyan-950 text-cyan-400 border border-cyan-800'
                      : u.role === 'ADMIN'
                      ? 'bg-blue-950 text-blue-400 border border-blue-800'
                      : 'bg-slate-950 text-slate-400 border border-slate-800'
                  }`}
                >
                  {u.role}
                </span>
                <span className="text-[10px] font-mono text-slate-400">{u.phone}</span>
              </div>

              {canManageUsers && (
                <div className="flex items-center justify-end gap-1.5 pt-1 border-t border-slate-800/40">
                  <button
                    onClick={() => setViewingUser(u)}
                    className="p-1 rounded-lg bg-slate-800 text-slate-300 hover:text-cyan-400 text-[10px] font-bold flex items-center gap-1"
                  >
                    <Eye className="w-3 h-3 text-cyan-400" />
                    <span>View</span>
                  </button>
                  <button
                    onClick={() => openEditModal(u)}
                    className="p-1 rounded-lg bg-slate-800 text-slate-300 hover:text-cyan-400 text-[10px] font-bold flex items-center gap-1"
                  >
                    <Edit2 className="w-3 h-3 text-cyan-400" />
                    <span>Edit</span>
                  </button>
                  <button
                    onClick={() => setResetPassUser(u)}
                    className="p-1 rounded-lg bg-slate-800 text-slate-300 hover:text-amber-400 text-[10px] font-bold flex items-center gap-1"
                  >
                    <Key className="w-3 h-3 text-amber-400" />
                    <span>Reset</span>
                  </button>
                  <button
                    onClick={() => setDeletingUserId(u.id)}
                    className="p-1 rounded-lg bg-red-950/80 text-red-400 hover:bg-red-900 text-[10px] font-bold flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Desktop View: Table */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[700px]">
            <thead className="bg-slate-950/90 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-3.5 px-4">{t('userHeader')}</th>
                <th className="py-3.5 px-4 text-center">{t('roleHeader')}</th>
                <th className="py-3.5 px-4 text-center">{t('statusHeader')}</th>
                <th className="py-3.5 px-4">{t('phoneHeader')}</th>
                <th className="py-3.5 px-4">{t('lastLogin')}</th>
                <th className="py-3.5 px-4 text-right">{t('actionsHeader')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 whitespace-nowrap">
              {visibleUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-slate-800 border border-cyan-500/40 flex items-center justify-center text-cyan-400 font-bold text-xs uppercase overflow-hidden shrink-0">
                        {u.name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold text-white">{u.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <span
                      className={`inline-flex items-center justify-center w-32 h-6.5 rounded-full text-[9px] font-bold uppercase tracking-wider gap-1 text-center whitespace-nowrap ${
                        u.role === 'SUPER_ADMIN'
                          ? 'bg-cyan-950 text-cyan-400 border border-cyan-800'
                          : u.role === 'ADMIN'
                          ? 'bg-blue-950 text-blue-400 border border-blue-800'
                          : 'bg-slate-950 text-slate-400 border border-slate-800'
                      }`}
                    >
                      {u.role === 'SUPER_ADMIN' ? (
                        <ShieldCheck className="w-3 h-3 text-cyan-400 shrink-0" />
                      ) : u.role === 'ADMIN' ? (
                        <UserCheck className="w-3 h-3 text-blue-400 shrink-0" />
                      ) : (
                        <UserIcon className="w-3 h-3 text-slate-400 shrink-0" />
                      )}
                      <span>{u.role}</span>
                    </span>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button
                      onClick={() => canManageUsers && toggleUserStatus(u.id)}
                      className={`inline-flex items-center justify-center w-20 h-6.5 rounded text-[9px] font-black uppercase tracking-wider text-center ${
                        u.status === 'ACTIVE'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-red-950 text-red-400 border border-red-800'
                      }`}
                    >
                      {u.status}
                    </button>
                  </td>
                  <td className="py-3 px-4 text-slate-300 font-mono text-[11px]">{u.phone}</td>
                  <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                    {formatDate(u.lastLogin)}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {canManageUsers ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setViewingUser(u)}
                          className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-cyan-400 transition-colors"
                          title="View User Details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => openEditModal(u)}
                          className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-cyan-400 transition-colors"
                          title="Edit User"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setResetPassUser(u)}
                          className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-400 transition-colors"
                          title="Reset Password"
                        >
                          <Key className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => toggleUserStatus(u.id)}
                          className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-300 transition-colors"
                          title="Disable / Enable User"
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeletingUserId(u.id)}
                          className="p-1.5 rounded-lg hover:bg-red-950 text-slate-400 hover:text-red-400 transition-colors"
                          title="Delete User Account"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-600 italic">No access</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* VIEW USER DETAIL MODAL */}
      {viewingUser && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-900/50 rounded-2xl p-5 w-full max-w-3xl shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-slate-800 border border-cyan-500/40 flex items-center justify-center text-cyan-400 font-black uppercase shrink-0">
                  {viewingUser.name.charAt(0)}
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-black text-white truncate">{viewingUser.name}</h2>
                  <p className="text-xs text-slate-400 font-mono truncate">{viewingUser.email}</p>
                </div>
              </div>
              <button
                onClick={() => setViewingUser(null)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="text-[10px] font-bold uppercase text-slate-500">Role</div>
                <div className="mt-1 text-xs font-black text-cyan-300">{viewingUser.role}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="text-[10px] font-bold uppercase text-slate-500">Phone</div>
                <div className="mt-1 text-xs font-mono text-slate-200">{viewingUser.phone}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="text-[10px] font-bold uppercase text-slate-500">Last Login</div>
                <div className="mt-1 text-xs font-mono text-slate-200">{formatDate(viewingUser.lastLogin)}</div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-white">Audit History</h3>
                <span className="text-[10px] font-mono text-slate-500">{viewingUserHistory.length} recent</span>
              </div>
              <div className="divide-y divide-slate-800/70">
                {viewingUserHistory.length > 0 ? (
                  viewingUserHistory.map((log) => (
                    <div key={log.id} className="grid grid-cols-1 sm:grid-cols-[120px_1fr_150px] gap-1.5 px-3 py-2.5 text-xs">
                      <div className="font-mono text-cyan-300">{log.type}</div>
                      <div className="text-slate-300 min-w-0">
                        <div className="font-bold truncate">{log.action}</div>
                        <div className="text-[10px] text-slate-500 truncate">{log.note || log.details}</div>
                      </div>
                      <div className="font-mono text-[10px] text-slate-500 sm:text-right">{formatDate(log.timestamp)}</div>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-6 text-center text-xs text-slate-500">No audit records visible for this user yet.</div>
                )}
              </div>
            </div>

            {canManageUsers && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 pt-3">
                <button
                  onClick={() => {
                    setViewingUser(null);
                    openEditModal(viewingUser);
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold hover:bg-slate-700 flex items-center gap-2"
                >
                  <Edit2 className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Edit Profile</span>
                </button>
                <button
                  onClick={() => {
                    setResetPassUser(viewingUser);
                    setViewingUser(null);
                  }}
                  className="px-3 py-2 rounded-xl bg-amber-950 text-amber-300 border border-amber-800 text-xs font-bold hover:bg-amber-900 flex items-center gap-2"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>Reset Password</span>
                </button>
                <button
                  onClick={() => toggleUserStatus(viewingUser.id)}
                  className="px-3 py-2 rounded-xl bg-slate-950 text-slate-300 border border-slate-700 text-xs font-bold hover:border-amber-700 hover:text-amber-300 flex items-center gap-2"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>{viewingUser.status === 'ACTIVE' ? 'Disable' : 'Enable'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ADD / EDIT USER MODAL */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-900/50 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-white">
                {editingUser ? t('editUser') : t('addUser')}
              </h2>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Full Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Inspector Hafiz"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="hafiz@track.gov.my"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Phone Number
                </label>
                <input
                  type="text"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+60 12-345 6789"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Role</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as Role })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    disabled={!canManageSystem}
                  >
                    <option value="USER">User (Field Officer)</option>
                    {canManageSystem && (
                      <>
                        <option value="ADMIN">Admin</option>
                        <option value="SUPER_ADMIN">Super Admin</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="DISABLED">DISABLED</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold hover:bg-slate-700"
                >
                  {t('cancelBtn')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider transition-all"
                >
                  {t('saveBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE USER CONFIRMATION MODAL */}
      {deletingUserId && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-red-900/60 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4 text-center">
            <div className="w-12 h-12 rounded-xl bg-red-950 border border-red-800 flex items-center justify-center mx-auto text-red-400">
              <Trash2 className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-bold text-white">{t('deleteUserTitle')}</h2>
            <p className="text-xs text-slate-300">
              {t('confirmDeleteUser')}{' '}
              <strong className="text-cyan-300">{deletingTarget?.name}</strong> ({deletingTarget?.email})
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setDeletingUserId(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold hover:bg-slate-700"
              >
                {t('cancelBtn')}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase"
              >
                {t('deleteAccountBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RESET PASSWORD MODAL */}
      {resetPassUser && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-amber-900/60 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Key className="w-5 h-5 text-amber-400" />
                <span>{t('resetPassword')}</span>
              </h2>
              <button
                onClick={() => setResetPassUser(null)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleResetPasswordSubmit} className="space-y-4">
              <p className="text-xs text-slate-300">
                {t('resetPasswordModalSub')} <span className="font-bold text-cyan-400">{resetPassUser.name}</span>.
              </p>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  {t('newPasswordLabel')}
                </label>
                <input
                  type="text"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono font-bold text-white focus:outline-none"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setResetPassUser(null)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
                >
                  {t('cancelBtn')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-amber-500 text-slate-950 font-black text-xs uppercase"
                >
                  {t('resetPassword')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

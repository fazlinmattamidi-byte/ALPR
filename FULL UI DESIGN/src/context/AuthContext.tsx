'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { Role, UserAccount } from '@/types';
import { initialUsers } from '@/lib/mockData';

interface AuthContextType {
  currentUser: UserAccount | null;
  role: Role;
  switchRole: (role: Role) => void;
  logout: () => void;
  loginAs: (user: UserAccount) => void;
  updateProfile: (updatedData: Partial<UserAccount>) => void;
  canEdit: boolean;
  canManageUsers: boolean;
  canManageVehicles: boolean;
  canManageSystem: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(initialUsers[0]); // Default Super Admin for easy testing
  const [role, setRole] = useState<Role>('SUPER_ADMIN');

  useEffect(() => {
    const savedRole = localStorage.getItem('track_user_role') as Role;
    if (savedRole) {
      setRole(savedRole);
      const match = initialUsers.find((u) => u.role === savedRole);
      if (match) setCurrentUser(match);
    }
  }, []);

  const switchRole = (newRole: Role) => {
    setRole(newRole);
    localStorage.setItem('track_user_role', newRole);
    const match = initialUsers.find((u) => u.role === newRole);
    if (match) {
      setCurrentUser(match);
    } else if (currentUser) {
      setCurrentUser({ ...currentUser, role: newRole });
    }
  };

  const loginAs = (user: UserAccount) => {
    setCurrentUser(user);
    setRole(user.role);
    localStorage.setItem('track_user_role', user.role);
  };

  const updateProfile = (updatedData: Partial<UserAccount>) => {
    if (currentUser) {
      const updated = { ...currentUser, ...updatedData };
      setCurrentUser(updated);
      localStorage.setItem('track_current_user', JSON.stringify(updated));
    }
  };

  const logout = () => {
    setCurrentUser(null);
    localStorage.removeItem('track_user_role');
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  };

  // Permission guards
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const canManageUsers = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const canManageVehicles = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const canManageSystem = role === 'SUPER_ADMIN';

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        role,
        switchRole,
        logout,
        loginAs,
        updateProfile,
        canEdit,
        canManageUsers,
        canManageVehicles,
        canManageSystem,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

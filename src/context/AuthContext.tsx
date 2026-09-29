'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Role, UserAccount } from '@/types';
import { initialUsers } from '@/lib/mockData';
import { getRolePermissions } from '@/lib/permissions';

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

interface AuthState {
  currentUser: UserAccount | null;
  role: Role;
}

function isRole(value: string | null): value is Role {
  return value === 'USER' || value === 'ADMIN' || value === 'SUPER_ADMIN';
}

function getInitialAuthState(): AuthState {
  if (typeof window === 'undefined') {
    return { currentUser: initialUsers[0], role: 'SUPER_ADMIN' };
  }

  const storedCurrentUser = localStorage.getItem('track_current_user');
  if (storedCurrentUser) {
    try {
      const parsedUser = JSON.parse(storedCurrentUser) as UserAccount;
      if (isRole(parsedUser.role)) {
        return { currentUser: parsedUser, role: parsedUser.role };
      }
    } catch {
      localStorage.removeItem('track_current_user');
    }
  }

  const savedRole = localStorage.getItem('track_user_role');
  const role = isRole(savedRole) ? savedRole : 'SUPER_ADMIN';
  const matchingUser = initialUsers.find((user) => user.role === role) ?? initialUsers[0];
  return { currentUser: matchingUser, role };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({ currentUser: initialUsers[0], role: 'SUPER_ADMIN' });
  const { currentUser, role } = authState;

  useEffect(() => {
    const id = window.setTimeout(() => {
      setAuthState(getInitialAuthState());
    }, 0);

    return () => window.clearTimeout(id);
  }, []);

  const switchRole = (newRole: Role) => {
    localStorage.setItem('track_user_role', newRole);
    const match = initialUsers.find((u) => u.role === newRole);
    if (match) {
      setAuthState({ currentUser: match, role: newRole });
    } else if (currentUser) {
      setAuthState({ currentUser: { ...currentUser, role: newRole }, role: newRole });
    } else {
      setAuthState({ currentUser: null, role: newRole });
    }
  };

  const loginAs = (user: UserAccount) => {
    setAuthState({ currentUser: user, role: user.role });
    localStorage.setItem('track_user_role', user.role);
    localStorage.setItem('track_current_user', JSON.stringify(user));
  };

  const updateProfile = (updatedData: Partial<UserAccount>) => {
    if (currentUser) {
      const updated = { ...currentUser, ...updatedData };
      setAuthState({ currentUser: updated, role: updated.role });
      localStorage.setItem('track_current_user', JSON.stringify(updated));
      localStorage.setItem('track_user_role', updated.role);
    }
  };

  const logout = () => {
    setAuthState({ currentUser: null, role });
    localStorage.removeItem('track_user_role');
    localStorage.removeItem('track_current_user');
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  };

  const { canEdit, canManageUsers, canManageVehicles, canManageSystem } = getRolePermissions(role);

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

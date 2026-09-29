import { Role } from '@/types';

export interface RolePermissions {
  canEdit: boolean;
  canManageUsers: boolean;
  canManageVehicles: boolean;
  canManageSystem: boolean;
}

export function getRolePermissions(role: Role): RolePermissions {
  const isAdminRole = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isSuperAdmin = role === 'SUPER_ADMIN';

  return {
    canEdit: isAdminRole,
    canManageUsers: isAdminRole,
    canManageVehicles: isAdminRole,
    canManageSystem: isSuperAdmin,
  };
}

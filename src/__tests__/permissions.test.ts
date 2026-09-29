import { describe, expect, it } from 'vitest';
import { getRolePermissions } from '../lib/permissions';

describe('role permissions', () => {
  it('keeps user accounts read-only for vehicle repository management', () => {
    expect(getRolePermissions('USER')).toMatchObject({
      canEdit: false,
      canManageVehicles: false,
      canManageSystem: false,
    });
  });

  it('allows admin roles to manage vehicles', () => {
    expect(getRolePermissions('ADMIN').canManageVehicles).toBe(true);
    expect(getRolePermissions('SUPER_ADMIN').canManageVehicles).toBe(true);
  });
});

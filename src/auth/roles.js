// Permission levels (Rulebook §2.2). Roles are nested:
//   admin      – awards points, sees and voids their own entries
//   logadmin   – everything an admin can do + reads the event log and suspicion report
//   superadmin – everything, including changing any value on the site
// Independently, an account can be casino staff: it records chips instead of points
// and can never award points itself (Rulebook §5.8).

export const ROLES = ['admin', 'logadmin', 'superadmin'];
const RANK = { admin: 1, logadmin: 2, superadmin: 3 };

export const hasRole = (user, role) => Boolean(user) && RANK[user.role] >= RANK[role];
export const isSuperadmin = (user) => user?.role === 'superadmin';
export const isCasinoStaff = (user) => Boolean(user?.is_casino);

/** Casino staff record chips, not points; the superadmin can always award. */
export const canAwardPoints = (user) => Boolean(user) && (isSuperadmin(user) || !isCasinoStaff(user));

/**
 * Feature switches restrict everyone except the superadmin, who operates the
 * switches and must never lock themselves out of fixing something mid-event.
 */
export const featureOn = (settings, user, key) => isSuperadmin(user) || settings.get(key);

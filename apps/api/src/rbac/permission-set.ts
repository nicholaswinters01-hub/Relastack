import type { PermissionKey, ResolvedPermissions } from '@platform/shared';

/**
 * What one caller may do, and where.
 *
 * The central idea of the permission model: a permission is never a plain
 * yes/no. It is a permission PLUS a scope, because a Location Manager manages
 * *specific* locations. Collapsing that into a boolean is what forces every
 * module to re-derive scoping for itself, inconsistently.
 *
 * Immutable and resolved once per request.
 */
export class PermissionSet {
  constructor(
    /** Granted everywhere in the organization. */
    private readonly organizationWide: ReadonlySet<string>,
    /** permission key -> the locations where it is granted. */
    private readonly byLocation: ReadonlyMap<string, ReadonlySet<string>>,
    /** Role keys held, for display and debugging. Never for authorization. */
    readonly roleKeys: readonly string[],
  ) {}

  static empty(): PermissionSet {
    return new PermissionSet(new Set(), new Map(), []);
  }

  /**
   * Is this permission held across the whole organization?
   *
   * Use for actions that are not about a particular location — renaming the
   * company, inviting someone, creating a location. A Location Manager holding
   * `location.assign` at two branches answers FALSE here, which is correct:
   * they cannot assign people organization-wide.
   */
  has(permission: PermissionKey): boolean {
    return this.organizationWide.has(permission);
  }

  /**
   * Is this permission held at a specific location?
   *
   * True when granted organization-wide (which necessarily includes this
   * location) or granted at this location in particular.
   */
  hasAt(permission: PermissionKey, locationId: string): boolean {
    if (this.organizationWide.has(permission)) return true;

    return this.byLocation.get(permission)?.has(locationId) ?? false;
  }

  /** Held either organization-wide or at least somewhere. */
  hasAnywhere(permission: PermissionKey): boolean {
    if (this.organizationWide.has(permission)) return true;

    return (this.byLocation.get(permission)?.size ?? 0) > 0;
  }

  /**
   * Which locations this permission reaches.
   *
   * Returns `null` for an organization-wide grant, meaning "all of them" —
   * deliberately not the current list of location ids. A list would be a
   * snapshot that silently excludes any location created afterwards, which is
   * exactly the bug that turns "admin sees everything" into "admin sees
   * everything from before last Tuesday".
   */
  locationsFor(permission: PermissionKey): ReadonlySet<string> | null {
    if (this.organizationWide.has(permission)) return null;

    return this.byLocation.get(permission) ?? new Set();
  }

  /** Serialisable form, for the API and the web client's navigation. */
  toJSON(): ResolvedPermissions {
    const byLocation: Record<string, string[]> = {};

    for (const [permission, locations] of this.byLocation) {
      byLocation[permission] = [...locations];
    }

    return {
      organizationWide: [...this.organizationWide],
      byLocation,
      roles: [...this.roleKeys],
    };
  }
}

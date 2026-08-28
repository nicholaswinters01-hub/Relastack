import { PERMISSIONS } from '@platform/shared';
import { describe, expect, it } from 'vitest';
import { PermissionSet } from './permission-set';

const DOWNTOWN = '11111111-1111-4111-8111-111111111111';
const NORTHSIDE = '22222222-2222-4222-8222-222222222222';
const WAREHOUSE = '33333333-3333-4333-8333-333333333333';

/** An Organization Administrator: everything, everywhere. */
const orgAdmin = new PermissionSet(
  new Set([PERMISSIONS.LOCATION_READ, PERMISSIONS.LOCATION_WRITE, PERMISSIONS.ORGANIZATION_WRITE]),
  new Map(),
  ['org_admin'],
);

/** A Location Manager: Downtown and Northside only. */
const locationManager = new PermissionSet(
  new Set([PERMISSIONS.ORGANIZATION_READ]),
  new Map([
    [PERMISSIONS.LOCATION_READ, new Set([DOWNTOWN, NORTHSIDE])],
    [PERMISSIONS.LOCATION_WRITE, new Set([DOWNTOWN, NORTHSIDE])],
  ]),
  ['location_manager'],
);

describe('PermissionSet', () => {
  describe('organization-wide grants', () => {
    it('answers true everywhere', () => {
      expect(orgAdmin.has(PERMISSIONS.LOCATION_WRITE)).toBe(true);
      expect(orgAdmin.hasAt(PERMISSIONS.LOCATION_WRITE, DOWNTOWN)).toBe(true);
      expect(orgAdmin.hasAt(PERMISSIONS.LOCATION_WRITE, WAREHOUSE)).toBe(true);
    });

    it('reports null locations, meaning "all of them"', () => {
      // Deliberately not a list of current ids: a snapshot would silently
      // exclude every location created afterwards.
      expect(orgAdmin.locationsFor(PERMISSIONS.LOCATION_READ)).toBeNull();
    });
  });

  describe('location-scoped grants', () => {
    it('does NOT answer true organization-wide', () => {
      // The distinction the whole model exists for. A Location Manager running
      // two branches must not be able to act company-wide.
      expect(locationManager.has(PERMISSIONS.LOCATION_WRITE)).toBe(false);
    });

    it('answers true at the assigned locations', () => {
      expect(locationManager.hasAt(PERMISSIONS.LOCATION_WRITE, DOWNTOWN)).toBe(true);
      expect(locationManager.hasAt(PERMISSIONS.LOCATION_WRITE, NORTHSIDE)).toBe(true);
    });

    it('answers false at an unassigned location', () => {
      expect(locationManager.hasAt(PERMISSIONS.LOCATION_WRITE, WAREHOUSE)).toBe(false);
    });

    it('reports exactly the assigned locations', () => {
      const allowed = locationManager.locationsFor(PERMISSIONS.LOCATION_READ);

      expect(allowed).not.toBeNull();
      expect([...allowed!].sort()).toEqual([DOWNTOWN, NORTHSIDE].sort());
    });

    it('hasAnywhere is true, has is false', () => {
      // What separates "may list their own branches" from "may act on the
      // whole company".
      expect(locationManager.hasAnywhere(PERMISSIONS.LOCATION_WRITE)).toBe(true);
      expect(locationManager.has(PERMISSIONS.LOCATION_WRITE)).toBe(false);
    });
  });

  describe('grants not held at all', () => {
    it('answers false everywhere', () => {
      expect(locationManager.has(PERMISSIONS.ORGANIZATION_WRITE)).toBe(false);
      expect(locationManager.hasAt(PERMISSIONS.ORGANIZATION_WRITE, DOWNTOWN)).toBe(false);
      expect(locationManager.hasAnywhere(PERMISSIONS.ORGANIZATION_WRITE)).toBe(false);
    });

    it('reports an empty location set, not null', () => {
      // Null means "everywhere". Returning it for an ungranted permission
      // would invert the meaning and grant access instead of denying it.
      const allowed = locationManager.locationsFor(PERMISSIONS.ORGANIZATION_WRITE);

      expect(allowed).not.toBeNull();
      expect(allowed!.size).toBe(0);
    });
  });

  describe('an empty set', () => {
    it('grants nothing', () => {
      const empty = PermissionSet.empty();

      expect(empty.has(PERMISSIONS.LOCATION_READ)).toBe(false);
      expect(empty.hasAt(PERMISSIONS.LOCATION_READ, DOWNTOWN)).toBe(false);
      expect(empty.hasAnywhere(PERMISSIONS.LOCATION_READ)).toBe(false);
      expect(empty.locationsFor(PERMISSIONS.LOCATION_READ)?.size).toBe(0);
    });
  });

  describe('combined grants', () => {
    it('unions organization-wide and scoped assignments', () => {
      // Ordinary arrangement: an org-wide Employee who also manages one branch.
      const combined = new PermissionSet(
        new Set([PERMISSIONS.LOCATION_READ]),
        new Map([[PERMISSIONS.LOCATION_WRITE, new Set([DOWNTOWN])]]),
        ['employee', 'location_manager'],
      );

      expect(combined.hasAt(PERMISSIONS.LOCATION_READ, WAREHOUSE)).toBe(true);
      expect(combined.hasAt(PERMISSIONS.LOCATION_WRITE, DOWNTOWN)).toBe(true);
      expect(combined.hasAt(PERMISSIONS.LOCATION_WRITE, WAREHOUSE)).toBe(false);
    });
  });

  describe('serialisation', () => {
    it('round-trips to a shape the web client can use', () => {
      const json = locationManager.toJSON();

      expect(json.organizationWide).toEqual([PERMISSIONS.ORGANIZATION_READ]);
      expect(json.byLocation[PERMISSIONS.LOCATION_WRITE]?.sort()).toEqual(
        [DOWNTOWN, NORTHSIDE].sort(),
      );
      expect(json.roles).toEqual(['location_manager']);
    });
  });
});
